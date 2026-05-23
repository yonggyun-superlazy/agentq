import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceStore } from "@agentq/core";
import { runCommand } from "../src/main.js";

describe("CLI required-response protocol", () => {
  it("lets a sender follow up after the receiver reports blocked evidence", async () => {
    const workspace = await createWorkspace("agentq-cli-follow-up-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiver = await enter(runtime, "claude-code", "receiver");

    await runCommand([
      "block",
      "--id",
      "AQ-blocked",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--summary",
      "Receiver is blocked"
    ], runtime);
    await runCommand([
      "respond",
      "AQ-blocked",
      "--actor",
      receiver,
      "--status",
      "blocked",
      "--evidence",
      "blocked by external owner",
      "--event",
      "EV-blocked"
    ], runtime);

    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("outbound_blocked_requires_follow_up")
    });
    await expect(runCommand([
      "follow-up",
      "AQ-blocked",
      "--actor",
      sender,
      "--to",
      receiver,
      "--evidence",
      "reframed with a new owner",
      "--event",
      "EV-follow-up"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("followed up")
    });
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 0
    });
  });

  it("lets a sender accept blocked evidence explicitly", async () => {
    const workspace = await createWorkspace("agentq-cli-accept-blocked-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiver = await enter(runtime, "claude-code", "receiver");

    await runCommand([
      "block",
      "--id",
      "AQ-accept-blocked",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--summary",
      "Receiver is blocked"
    ], runtime);
    await runCommand([
      "respond",
      "AQ-accept-blocked",
      "--actor",
      receiver,
      "--status",
      "blocked",
      "--evidence",
      "blocked by external owner",
      "--event",
      "EV-blocked"
    ], runtime);

    await expect(runCommand([
      "accept-blocked",
      "AQ-accept-blocked",
      "--actor",
      sender,
      "--to",
      receiver,
      "--evidence",
      "external blocker accepted",
      "--event",
      "EV-accept-blocked"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("accepted blocked")
    });
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 0
    });
  });

  it("routes resource questions to active resource owners", async () => {
    const workspace = await createWorkspace("agentq-cli-resource-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiverResult = await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "setup-owner",
      "--paths",
      "ProjectDD",
      "--resource",
      "setup-watcher:ProjectDD/DDSetup",
      "--responsibility",
      "DD setup watcher"
    ], runtime);
    const receiver = receiverResult.stdout.trim().replace(/ registered$/, "");

    await expect(runCommand([
      "owners",
      "--resource",
      "setup-watcher:ProjectDD/DDSetup",
      "--actor",
      sender
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining(receiver)
    });

    await expect(runCommand([
      "question",
      "--id",
      "AQ-resource-question",
      "--actor",
      sender,
      "--resource",
      "setup-watcher:ProjectDD/DDSetup",
      "--question",
      "Can DDSetup finish or confirm current watcher status?",
      "--expect",
      "Answer with current watcher state and evidence"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining(`AQ-resource-question routed to ${receiver}`)
    });
  });

  it.each(["typo", "superseded"])(
    "rejects invalid terminal response status %s before it is written",
    async (status) => {
    const workspace = await createWorkspace("agentq-cli-invalid-event-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiver = await enter(runtime, "claude-code", "receiver");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });

    await runCommand([
      "block",
      "--id",
      "AQ-invalid-event",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--summary",
      "Invalid response should not be durable"
    ], runtime);

    await expect(runCommand([
      "respond",
      "AQ-invalid-event",
      "--actor",
      receiver,
      "--status",
      status,
      "--evidence",
      "bad status",
      "--event",
      "EV-bad"
    ], runtime)).rejects.toThrow();
    await expect(readFile(store.layout.eventPath("AQ-invalid-event", "EV-bad"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    }
  );

  it("rejects responses from actors that are not the requested recipient", async () => {
    const workspace = await createWorkspace("agentq-cli-wrong-actor-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiver = await enter(runtime, "claude-code", "receiver");
    const other = await enter(runtime, "copilot-cli", "other");

    await runCommand([
      "block",
      "--id",
      "AQ-wrong-actor",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--summary",
      "Only the receiver can answer"
    ], runtime);

    await expect(runCommand([
      "respond",
      "AQ-wrong-actor",
      "--actor",
      other,
      "--status",
      "resolved",
      "--evidence",
      "wrong actor",
      "--event",
      "EV-wrong"
    ], runtime)).rejects.toThrow(/no required request/);
  });

  it("rejects unsafe ids before runtime files can escape the store", async () => {
    const workspace = await createWorkspace("agentq-cli-unsafe-id-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiver = await enter(runtime, "claude-code", "receiver");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });

    await expect(runCommand([
      "block",
      "--id",
      "../AQ-escape",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--summary",
      "Unsafe id"
    ], runtime)).rejects.toThrow(/identifier/);
    await expect(stat(path.join(store.layout.root, "AQ-escape"))).rejects.toMatchObject({
      code: "ENOENT"
    });

    await expect(runCommand([
      "work",
      "start",
      "--actor",
      "../codex",
      "--id",
      "AW-unsafe",
      "--title",
      "Unsafe actor",
      "--path",
      "README.md"
    ], runtime)).rejects.toThrow(/identifier/);
    await expect(stat(path.join(store.layout.workDir, "codex"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

type TestRuntime = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => string;
};

async function createWorkspace(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

function createRuntime(workspace: string): TestRuntime {
  return {
    cwd: workspace,
    env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
    now: () => "2026-05-18T00:00:00.000Z"
  };
}

async function enter(
  runtime: TestRuntime,
  adapter: "codex" | "claude-code" | "copilot-cli",
  session: string
): Promise<string> {
  const result = await runCommand([
    "enter",
    "--as",
    adapter,
    "--session",
    session,
    "--paths",
    "README.md",
    "--responsibility",
    `${session} owner`
  ], runtime);
  return result.stdout.trim().replace(/ registered$/, "");
}
