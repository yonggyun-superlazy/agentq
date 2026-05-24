import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { appendDiagnosticEvent, ensureWorkspaceStore, readDiagnosticEvents, resolveWorkspaceStore } from "@agentq/core";
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

  it("prints diagnostic ring log entries", async () => {
    const workspace = await createWorkspace("agentq-cli-diag-");
    const runtime = createRuntime(workspace);
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await ensureWorkspaceStore(store);
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:00:00.000Z",
      actorId: "codex@workspace@diag",
      event: "pre-tool",
      toolName: "Bash",
      paths: ["."],
      resources: [],
      ignoredCommands: ["agentq owners --resource unity:ProjectDD/DDUnity"],
      nudge: false
    });

    await expect(runCommand(["diag", "--limit", "5"], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ignored:1")
    });
  });

  it("retains more than the old 200 diagnostic ring entries", async () => {
    const workspace = await createWorkspace("agentq-cli-diag-retention-");
    const runtime = createRuntime(workspace);
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await ensureWorkspaceStore(store);

    for (let index = 0; index < 250; index += 1) {
      await appendDiagnosticEvent(store, {
        kind: "hook",
        at: `2026-05-18T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        actorId: "codex@workspace@diag-retention",
        event: "pre-tool",
        toolName: "Bash"
      });
    }

    const events = await readDiagnosticEvents(store, 300);
    expect(events).toHaveLength(250);
    expect(events[0]?.at).toBe("2026-05-18T00:00:00.000Z");
  }, 10_000);

  it("prints actor activity from diagnostic hook gaps", async () => {
    const workspace = await createWorkspace("agentq-cli-diag-activity-");
    const runtime = createRuntime(workspace, "2026-05-18T00:10:00.000Z");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await ensureWorkspaceStore(store);
    const actorId = await enter(runtime, "codex", "activity");

    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:00:00.000Z",
      actorId,
      event: "pre-tool",
      toolName: "Bash",
      paths: ["README.md"],
      nudge: true,
      nudgeKinds: ["work-adoption"]
    });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:01:00.000Z",
      actorId,
      event: "pre-tool",
      toolName: "Bash"
    });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:05:00.000Z",
      actorId,
      event: "stop"
    });
    await runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-diag",
      "--title",
      "Diagnose activity output",
      "--path",
      "README.md"
    ], runtime);

    await expect(runCommand(["diag", "activity", "--window", "1h"], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("AgentQ diagnostic activity")
    });
    const result = await runCommand(["diag", "activity", "--window", "1h"], runtime);
    expect(result.stdout).toContain(actorId);
    expect(result.stdout).toContain("events:3");
    expect(result.stdout).toContain("lastEvent:5m");
    expect(result.stdout).toContain("maxGap:4m");
    expect(result.stdout).toContain("p95Gap:4m");
    expect(result.stdout).toContain("avgGap:2m");
    expect(result.stdout).toContain("work:open");
    expect(result.stdout).toContain("adoption:tracked-work");
    expect(result.stdout).toContain("workNudges:1");
    expect(result.stdout).toContain("evidence:0");
    expect(result.stdout).toContain("workTitle:Diagnose activity output");
    expect(result.stdout).toContain("paths:README.md");
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

function createRuntime(workspace: string, now = "2026-05-18T00:00:00.000Z"): TestRuntime {
  return {
    cwd: workspace,
    env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
    now: () => now
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
