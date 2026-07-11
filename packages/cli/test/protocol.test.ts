import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand, type CommandResult, type CommandRuntime } from "../src/main.js";

describe("reduced CLI protocol", () => {
  it("registers exact sessions and drives claims plus read-only owner lookup", async () => {
    const runtime = await createRuntime();
    const requester = await register(runtime, "vendor-one", "session-a");
    const owner = await register(runtime, "vendor-two", "session-b");

    expectJson(await runCommand([
      "claims", "set", "--actor", owner,
      "--path", "src/**", "--resource", "resource:workspace-a", "--contract", "contract-a"
    ], runtime), "claims_set");
    const owners = expectJson(await runCommand([
      "owners", "--actor", requester,
      "--path", "src/file.ts", "--resource", "resource:workspace-a", "--contract", "contract-a"
    ], runtime), "owners");
    expect(owners.owners).toEqual([expect.objectContaining({ actorId: owner })]);

    expectJson(await runCommand(["claims", "clear", "--actor", owner], runtime), "claims_cleared");
    const afterClear = expectJson(
      await runCommand(["owners", "--actor", requester, "--path", "src/file.ts"], runtime),
      "owners"
    );
    expect(afterClear.owners).toEqual([]);
  });

  it("dispatches question, answer, not_mine, cancel, and inbox", async () => {
    const runtime = await createRuntime();
    const sender = await register(runtime, "codex", "session-a");
    const recipient = await register(runtime, "claude", "session-b");
    expectJson(
      await runCommand(["claims", "set", "--actor", recipient, "--path", "src/**"], runtime),
      "claims_set"
    );

    const answeredId = await ask(runtime, sender, recipient, "Who owns src/a.ts?");
    expect(expectJson(await runCommand(["inbox", "--actor", recipient], runtime), "inbox").questions).toHaveLength(1);
    expectJson(
      await runCommand(["answer", answeredId, "--actor", recipient, "--answer", "I own it."], runtime),
      "question_answered"
    );

    const declinedId = await ask(runtime, sender, recipient, "Who owns src/b.ts?");
    expectJson(
      await runCommand(["not_mine", declinedId, "--actor", recipient], runtime),
      "question_not_mine"
    );

    const cancelledId = await ask(runtime, sender, recipient, "Who owns src/c.ts?");
    expectJson(
      await runCommand(["cancel", cancelledId, "--actor", sender], runtime),
      "question_cancelled"
    );
    expect(expectJson(await runCommand(["inbox", "--actor", recipient], runtime), "inbox").questions).toEqual([]);
  });

  it("does not invent missing registration identity", async () => {
    const runtime = await createRuntime();
    await expect(runCommand(["register", "--adapter", "codex"], runtime)).resolves.toEqual({
      code: 2,
      stdout: "",
      stderr: "agentq:invalid_arguments: missing --session\n"
    });
  });

  it("runs invalid hook input as a quiet fail-open boundary", async () => {
    const runtime = await createRuntime();
    await expect(
      runCommand(["hook", "codex", "session-start"], {
        ...runtime,
        readStdin: async () => "not-json"
      })
    ).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

async function register(runtime: CommandRuntime, adapter: string, session: string): Promise<string> {
  const result = expectJson(
    await runCommand(["register", "--adapter", adapter, "--session", session], runtime),
    "registered"
  );
  expect(result.actorId).toMatch(/^actor_[0-9a-f]{24}$/);
  return String(result.actorId);
}

async function ask(
  runtime: CommandRuntime,
  sender: string,
  recipient: string,
  question: string
): Promise<string> {
  const result = expectJson(await runCommand([
    "question", "--actor", sender, "--to", recipient,
    "--question", question, "--path", "src/**"
  ], runtime), "question_created");
  return String(result.questionId);
}

function expectJson(result: CommandResult, code: string): Record<string, unknown> {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(value.code).toBe(code);
  return value;
}

async function createRuntime(): Promise<CommandRuntime> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-reduced-"));
  return {
    cwd: workspace,
    env: { LOCALAPPDATA: path.join(workspace, "state") },
    now: () => new Date().toISOString()
  };
}
