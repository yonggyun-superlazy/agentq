import { readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  appendDiagnosticEvent,
  ensureWorkspaceStore,
  foldMessageState,
  readDiagnosticEvents,
  resolveWorkspaceStore
} from "@agentq/core";
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
      stderr: expect.stringContaining("blocked reply follow-up: Receiver is blocked")
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

  it("routes guessed state path queries to owners without making state a public command", async () => {
    const workspace = await createWorkspace("agentq-cli-state-compat-");
    const runtime = createRuntime(workspace);
    const ownerResult = await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "dd-owner",
      "--paths",
      "ProjectDD/DD.Shared",
      "--responsibility",
      "DD shared owner"
    ], runtime);
    const owner = ownerResult.stdout.trim().replace(/ registered$/, "");

    await expect(runCommand(["state", "--paths", "ProjectDD/DD.Shared"], runtime)).resolves.toMatchObject({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("agentq state path/resource queries are routed to agentq owners")
    });
    const result = await runCommand(["state", "--paths", "ProjectDD/DD.Shared"], runtime);
    expect(result.stdout).toContain("owners for ProjectDD/DD.Shared");
    expect(result.stdout).toContain(owner);
  });

  it("reconstructs shell-split question and response text by default", async () => {
    const workspace = await createWorkspace("agentq-cli-question-quote-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiver = await enter(runtime, "claude-code", "receiver");

    await expect(runCommand([
      "question",
      "--id",
      "AQ-split-question",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--question",
      '"I',
      "am",
      "checking",
      "whether",
      "you",
      "still",
      "own",
      "this",
      "file",
      "--expect",
      "Answer",
      "with",
      "evidence"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("AQ-split-question routed")
    });

    await expect(runCommand([
      "respond",
      "AQ-split-question",
      "--actor",
      receiver,
      "--status",
      "answered",
      "--evidence",
      "No",
      "overlap",
      "with",
      "my",
      "current",
      "work"
    ], runtime)).resolves.toEqual({
      code: 0,
      stdout: "AQ-split-question answered\n",
      stderr: ""
    });

    const state = await foldMessageState(await resolveWorkspaceStore(workspace, { env: runtime.env }), "AQ-split-question");
    expect(state.message).toMatchObject({
      kind: "question",
      question: "I am checking whether you still own this file",
      expectedAnswer: "Answer with evidence"
    });
    expect(state.events).toContainEqual(expect.objectContaining({
      kind: "response",
      evidence: ["No overlap with my current work"]
    }));
  });

  it("rejects short truncated response fragments before writing them", async () => {
    const workspace = await createWorkspace("agentq-cli-response-fragment-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiver = await enter(runtime, "claude-code", "receiver");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });

    await runCommand([
      "question",
      "--id",
      "AQ-response-fragment",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--question",
      "Can I edit README now?",
      "--expect",
      "Answer with evidence"
    ], runtime);

    await expect(runCommand([
      "respond",
      "AQ-response-fragment",
      "--actor",
      receiver,
      "--status",
      "answered",
      "--evidence",
      '"No'
    ], runtime)).rejects.toThrow(/looks truncated/);
    const state = await foldMessageState(store, "AQ-response-fragment");
    expect(state.events).not.toContainEqual(expect.objectContaining({
      kind: "response"
    }));
  });

  it("reads long question and response text from files to avoid shell quoting loss", async () => {
    const workspace = await createWorkspace("agentq-cli-question-file-");
    const runtime = createRuntime(workspace);
    const sender = await enter(runtime, "codex", "sender");
    const receiver = await enter(runtime, "claude-code", "receiver");
    const questionPath = path.join(workspace, "question.txt");
    const evidencePath = path.join(workspace, "evidence.txt");
    await writeFile(
      questionPath,
      "Can I run the shared PlayMode verification now, or do you still own the Unity test host?",
      "utf8"
    );
    await writeFile(
      evidencePath,
      "Safe to run now. My test host edits are closed and the latest targeted PlayMode run passed.",
      "utf8"
    );

    await expect(runCommand([
      "question",
      "--id",
      "AQ-file-question",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "Shared/Superlazy.Unity.TestHost",
      "--question-file",
      questionPath,
      "--expect",
      "Answer with current test host ownership evidence"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("AQ-file-question routed")
    });

    await expect(runCommand([
      "respond",
      "AQ-file-question",
      "--actor",
      receiver,
      "--status",
      "answered",
      "--evidence",
      '"No'
    ], runtime)).rejects.toThrow(/looks truncated/);

    await expect(runCommand([
      "respond",
      "AQ-file-question",
      "--actor",
      receiver,
      "--status",
      "answered",
      "--evidence-file",
      evidencePath
    ], runtime)).resolves.toEqual({
      code: 0,
      stdout: "AQ-file-question answered\n",
      stderr: ""
    });

    const state = await foldMessageState(await resolveWorkspaceStore(workspace, { env: runtime.env }), "AQ-file-question");
    expect(state.message).toMatchObject({
      kind: "question",
      question: "Can I run the shared PlayMode verification now, or do you still own the Unity test host?"
    });
    expect(state.events).toContainEqual(expect.objectContaining({
      kind: "response",
      evidence: ["Safe to run now. My test host edits are closed and the latest targeted PlayMode run passed."]
    }));
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
  }, 20_000);

  it("prints actor activity from diagnostic hook gaps", async () => {
    const workspace = await createWorkspace("agentq-cli-diag-activity-");
    const runtime = createRuntime(workspace, "2026-05-18T00:10:00.000Z");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await ensureWorkspaceStore(store);
    const actorId = await enter(runtime, "codex", "activity");
    const claudeActorId = await enter(runtime, "claude-code", "activity-claude");
    const copilotActorId = await enter(runtime, "copilot-cli", "activity-copilot");

    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:00:00.000Z",
      actorId,
      adapter: "codex",
      event: "pre-tool",
      toolName: "Bash",
      toolMode: "mutating",
      paths: ["README.md"],
      nudge: true,
      nudgeKinds: ["work-adoption"]
    });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:01:00.000Z",
      actorId,
      adapter: "codex",
      event: "pre-tool",
      toolName: "Bash",
      toolMode: "read-only"
    });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:05:00.000Z",
      actorId,
      adapter: "codex",
      event: "stop",
      toolMode: "stop"
    });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:06:00.000Z",
      actorId: claudeActorId,
      adapter: "claude-code",
      event: "pre-tool",
      toolName: "Bash",
      toolMode: "mutating",
      paths: ["README.md"],
      nudge: true,
      nudgeKinds: ["owner-overlap"]
    });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:07:00.000Z",
      actorId: copilotActorId,
      adapter: "copilot-cli",
      event: "pre-tool",
      toolName: "Bash",
      toolMode: "mutating",
      paths: ["."],
      nudge: false
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
    expect(result.stdout).toContain("Agents:");
    expect(result.stdout).toContain("codex: actors:1 | events:3");
    expect(result.stdout).toContain("claude-code: actors:1 | events:1");
    expect(result.stdout).toContain("copilot-cli: actors:1 | events:1");
    expect(result.stdout).toContain("readOnly:1");
    expect(result.stdout).toContain("mutating:1");
    expect(result.stdout).toContain("stop:1");
    expect(result.stdout).toContain("ownerNudges:1");
    expect(result.stdout).toContain("Coordination:");
    expect(result.stdout).toContain("ownerNudges:1 | recentMessages:0 | ownerMessageConversion:missing");
    expect(result.stdout).toContain("Evidence boundary:");
    expect(result.stdout).toContain("Activity counts are routing telemetry, not answer-quality proof");
    expect(result.stdout).toContain("Quality claims need actual message/request/response text");
    expect(result.stdout).toContain("diagnosis:coordination-owner-routing");
    expect(result.stdout).toContain("diagnosis:agent-scope-missing");
    expect(result.stdout).toContain("agent:codex");
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

  it("reports owner-overlap conversion when a recent message exists", async () => {
    const workspace = await createWorkspace("agentq-cli-diag-conversion-");
    const runtime = createRuntime(workspace, "2026-05-18T00:10:00.000Z");
    const sender = await enter(runtime, "codex", "conversion-sender");
    const receiver = await enter(runtime, "claude-code", "conversion-receiver");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });

    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:09:00.000Z",
      actorId: sender,
      adapter: "codex",
      event: "pre-tool",
      toolName: "Bash",
      toolMode: "mutating",
      paths: ["README.md"],
      nudge: true,
      nudgeKinds: ["owner-overlap"]
    });
    await runCommand([
      "question",
      "--id",
      "AQ-owner-conversion",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--question",
      "Can I edit README without overlapping your work?",
      "--expect",
      "Answer with current ownership evidence"
    ], runtime);

    const result = await runCommand(["diag", "activity", "--window", "1h"], runtime);

    expect(result.stdout).toContain("ownerNudges:1 | recentMessages:1 | ownerMessageConversion:observed");
    expect(result.stdout).toContain("Activity counts are routing telemetry, not answer-quality proof");
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
