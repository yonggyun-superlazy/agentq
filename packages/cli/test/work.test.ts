import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendDiagnosticEvent,
  appendWorkEvidence,
  closeWork,
  foldMessageState,
  readActiveWorkState,
  resolveWorkspaceStore,
  startWork,
  writeAtomicYaml
} from "@agentq/core";
import { runCommand } from "../src/main.js";

describe("CLI work stack", () => {
  it("lists actors and gates done-check on active work until evidence and close", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-work-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };

    const entered = await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "work-test",
      "--paths",
      "AgentQ",
      "--responsibility",
      "work stack"
    ], runtime);
    const actorId = entered.stdout.trim().replace(/ registered$/, "");

    await expect(runCommand(["actors"], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining(actorId)
    });

    await expect(runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-cli",
      "--title",
      "Implement work stack",
      "--path",
      "AgentQ/packages/core/src/work/workStack.ts"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("started: AW-cli")
    });
    await expect(runCommand(["work", "status", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("next: record collaboration context now")
    });

    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Active shared-work item remains open")
    });
    await expect(runCommand([
      "work",
      "touch",
      "--actor",
      actorId,
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("AgentQ/packages/cli/src/main.ts")
    });
    await expect(runCommand([
      "work",
      "evidence",
      "--actor",
      actorId,
      "--evidence",
      "CLI work test recorded evidence"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("evidence: 1")
    });
    await expect(runCommand([
      "work",
      "close",
      "--actor",
      actorId,
      "--summary",
      "CLI work stack closed"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("closed: AW-cli")
    });
    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toEqual({
      code: 0,
      stdout: "ok: no required replies or active work remain open\n",
      stderr: ""
    });
  });

  it("closes stale work with an explicit terminal status and evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-work-terminal-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "terminal-work",
      "--paths",
      "AgentQ/packages/core/src/work/workStack.ts",
      "--responsibility",
      "work lifecycle"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-terminal",
      "--title",
      "Old stale work",
      "--path",
      "AgentQ/packages/core/src/work/workStack.ts"
    ], runtime);

    const result = await runCommand([
      "work",
      "close",
      "--actor",
      actorId,
      "--status",
      "abandoned",
      "--summary",
      "Later frame replaced this work",
      "--evidence",
      "Current owner verified no remaining action."
    ], runtime);

    expect(result).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(result.stdout).toContain("closed: AW-terminal");
    expect(result.stdout).toContain("status: abandoned");
    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 0
    });
  });

  it("rejects broad work start paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-work-broad-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "work-broad",
      "--paths",
      "AgentQ",
      "--responsibility",
      "work stack"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await expect(runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--title",
      "Broad work"
    ], runtime)).rejects.toThrow(/work start requires --path <specific-path>/);
    await expect(runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--title",
      "Broad work",
      "--path",
      "."
    ], runtime)).rejects.toThrow(/broad/);
    await expect(runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--title",
      "Broad work",
      "--path",
      "./"
    ], runtime)).rejects.toThrow(/broad/);
  });

  it("rejects dangling quoted work titles and responsibilities", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-work-text-quality-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };

    await expect(runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "short",
      "--paths",
      "README.md",
      "--responsibility",
      "consumer"
    ], runtime)).resolves.toMatchObject({
      code: 0
    });

    await expect(runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "broken",
      "--paths",
      "README.md",
      "--responsibility",
      '"Implement'
    ], runtime)).rejects.toThrow(/looks truncated/);

    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "work-title",
      "--paths",
      "README.md",
      "--responsibility",
      "README owner"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await expect(runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--title",
      '"Diagnose',
      "--path",
      "README.md"
    ], runtime)).rejects.toThrow(/looks truncated/);
  });

  it("lets the sender supersede an outbound request without impersonating the receiver", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-supersede-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "docs/instructions.md",
      "--responsibility",
      "instruction sender"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "README.md",
      "--responsibility",
      "instruction receiver"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await runCommand([
      "block",
      "--id",
      "AQ-supersede",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--summary",
      "Propagation request"
    ], runtime);
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("outbound required reply: Propagation request")
    });

    await expect(runCommand([
      "supersede",
      "AQ-supersede",
      "--actor",
      sender,
      "--to",
      receiver,
      "--evidence",
      "receiver is stale; propagation remains documented"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("superseded")
    });
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 0
    });
    await expect(runCommand(["inbox", "--actor", receiver], runtime)).resolves.toEqual({
      code: 0,
      stdout: "inbox empty\n",
      stderr: ""
    });
  });

  it("auto-routes blockers by active path when --to is omitted", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-auto-route-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "AgentQ",
      "--responsibility",
      "agentq maintainer"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "packages/service/**",
      "--responsibility",
      "service build owner"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await expect(runCommand([
      "block",
      "--id",
      "AQ-auto-route",
      "--actor",
      sender,
      "--path",
      "packages/service/package.json",
      "--summary",
      "Stale project reference blocks build"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining(`AQ-auto-route routed to ${receiver}`)
    });
    await expect(runCommand(["inbox", "--actor", receiver], runtime)).resolves.toMatchObject({
      stdout: expect.stringContaining("respond: agentq respond AQ-auto-route")
    });
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("outbound required reply: Stale project reference blocks build")
    });
  });

  it("refreshes the hook-provided actor id instead of creating a second actor", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-enter-actor-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "claude-code-session",
      "--paths",
      ".",
      "--responsibility",
      "claude-code session"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await expect(runCommand([
      "enter",
      "--actor",
      actorId,
      "--paths",
      "packages/runtime/src/eventBus.ts",
      "--responsibility",
      "event bus owner",
      "--summary",
      "event bus scope"
    ], runtime)).resolves.toEqual({
      code: 0,
      stdout: `${actorId} refreshed\n`,
      stderr: ""
    });
    const actors = await runCommand(["actors"], runtime);
    expect(actors.stdout).toContain("actors: 1");
    expect(actors.stdout).toContain(actorId);
    expect(actors.stdout).toContain("packages/runtime/src/eventBus.ts");
    expect(actors.stdout).not.toContain("routing: broad");
  });

  it("gates done-check on broad actor scope until the exact actor is refreshed", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-scope-check-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const actorId = (await runCommand(["enter", "--as", "codex", "--session", "broad"], runtime)).stdout
      .trim()
      .replace(/ registered$/, "");

    await expect(runCommand(["scope-check", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(`agentq next --actor ${actorId}`)
    });
    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(`agentq next --actor ${actorId}`)
    });
    await expect(runCommand(["next", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("--resource conversation:current-request")
    });

    await runCommand([
      "enter",
      "--actor",
      actorId,
      "--paths",
      "packages/runtime/src/eventBus.ts",
      "--responsibility",
      "event bus owner"
    ], runtime);

    await expect(runCommand(["scope-check", "--actor", actorId], runtime)).resolves.toEqual({
      code: 0,
      stdout: "ok: actor scope is specific\n",
      stderr: ""
    });
    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 0
    });
  });

  it("routes required questions and gates the sender until the receiver answers", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-question-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "packages/ui/src/statusPanel.ts",
      "--responsibility",
      "status panel view"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "packages/runtime/src/eventBus.ts",
      "--responsibility",
      "event bus owner"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await expect(runCommand([
      "question",
      "--id",
      "AQ-question",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "packages/runtime/src/eventBus.ts",
      "--question",
      "Should status panel badges read from event payload or derived view state?",
      "--expect",
      "Answer owner and state source"
    ], runtime)).resolves.toEqual({
      code: 0,
      stdout: expect.stringContaining(`AQ-question routed to ${receiver}`),
      stderr: ""
    });
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("outbound required reply: Should status panel badges read from event payload or derived view state?")
    });
    await expect(runCommand(["inbox", "--actor", receiver], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("respond: agentq respond AQ-question"),
      stderr: ""
    });
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    const state = await foldMessageState(store, "AQ-question");
    expect(state.events).toEqual([
      expect.objectContaining({
        kind: "delivery_attempt",
        actorId: receiver,
        status: "record_only"
      })
    ]);
    await expect(runCommand([
      "respond",
      "AQ-question",
      "--actor",
      receiver,
      "--status",
      "answered",
      "--evidence",
      "Status panel badges should use event.payload.status."
    ], runtime)).resolves.toEqual({
      code: 0,
      stdout: "AQ-question answered\n",
      stderr: ""
    });
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 0
    });
  });

  it("renders inbox as a resolve queue with return stack and supports the legacy A/B toggle", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-inbox-queue-stack-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "packages/ui/src/statusPanel.ts",
      "--responsibility",
      "status panel view"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "packages/runtime/src/eventBus.ts",
      "--responsibility",
      "event bus owner"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await runCommand([
      "work",
      "start",
      "--actor",
      receiver,
      "--id",
      "AW-inbox-stack",
      "--title",
      "Handle runtime event ownership",
      "--path",
      "packages/runtime/src/eventBus.ts"
    ], runtime);
    await runCommand([
      "question",
      "--id",
      "AQ-inbox-stack",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "packages/runtime/src/eventBus.ts",
      "--question",
      "Which state source owns badges?",
      "--expect",
      "Answer with owner evidence"
    ], runtime);

    const enhanced = await runCommand(["inbox", "--actor", receiver], runtime);
    expect(enhanced.stdout).toContain(`Resolve queue for ${receiver}`);
    expect(enhanced.stdout).toContain("Required: 1");
    expect(enhanced.stdout).toContain("Optional: 0");
    expect(enhanced.stdout).toContain("Return stack:");
    expect(enhanced.stdout).toContain("current: AW-inbox-stack - Handle runtime event ownership");
    expect(enhanced.stdout).toContain("why: required reply blocks done-check");
    expect(enhanced.stdout).toContain("related: current stack path overlap: packages/runtime/src/eventBus.ts");
    expect(enhanced.stdout).toContain("respond: agentq respond AQ-inbox-stack");

    await expect(runCommand(["next", "--actor", receiver], runtime)).resolves.toMatchObject({
      stdout: expect.stringContaining("current: AW-inbox-stack - Handle runtime event ownership")
    });

    const legacyRuntime = {
      ...runtime,
      env: { ...runtime.env, AGENTQ_QUEUE_STACK_UX: "0" }
    };
    const legacy = await runCommand(["inbox", "--actor", receiver], legacyRuntime);
    expect(legacy.stdout).toContain("AQ-inbox-stack\n  kind: question");
    expect(legacy.stdout).not.toContain("Resolve queue for");
    expect(legacy.stdout).not.toContain("Return stack:");
  });

  it("renders one next action for required inbox and answered outbound replies", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-next-question-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "packages/ui/src/statusPanel.ts",
      "--responsibility",
      "status panel view"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "packages/runtime/src/eventBus.ts",
      "--responsibility",
      "event bus owner"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await runCommand([
      "question",
      "--id",
      "AQ-next",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "packages/runtime/src/eventBus.ts",
      "--question",
      "Which state source owns badges?",
      "--expect",
      "Answer with owner evidence"
    ], runtime);

    await expect(runCommand(["next", "--actor", receiver], runtime)).resolves.toMatchObject({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("Action: answer the required inbox item.")
    });
    await expect(runCommand(["next", "--actor", receiver], runtime)).resolves.toMatchObject({
      stdout: expect.stringContaining(`agentq respond AQ-next --actor ${receiver} --status answered`)
    });
    const pendingNext = await runCommand(["next", "--actor", sender], runtime);
    expect(pendingNext).toMatchObject({
      code: 0,
      stderr: "",
      stdout: expect.stringContaining("Action: wait for the required reply; do not poll AgentQ")
    });
    expect(pendingNext.stdout).toContain("Next local action: continue only work that cannot touch this reply path");
    expect(pendingNext.stdout).not.toContain("Check again:");
    expect(pendingNext.stdout).not.toContain(`agentq next --actor ${sender}`);

    await runCommand([
      "respond",
      "AQ-next",
      "--actor",
      receiver,
      "--status",
      "answered",
      "--evidence",
      "Badges read from event payload."
    ], runtime);

    await expect(runCommand(["next", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Action: continue current task with the answered evidence below.")
    });
    await expect(runCommand(["next", "--actor", sender], runtime)).resolves.toMatchObject({
      stdout: expect.stringContaining("Badges read from event payload.")
    });
  });

  it("renders active work as the next action before final done-check", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-next-work-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "next-work",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ next command"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-next",
      "--title",
      "Thin AgentQ CLI",
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], runtime);

    await expect(runCommand(["next", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Action: record context evidence for your active work.")
    });
    await runCommand([
      "work",
      "evidence",
      "--actor",
      actorId,
      "--evidence",
      "Context recorded."
    ], runtime);
    await expect(runCommand(["next", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Action: close or update your active work before claiming done.")
    });
  });

  it("renders nested work stack lineage in status and next", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-stack-lineage-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "stack-lineage",
      "--paths",
      "AgentQ",
      "--responsibility",
      "AgentQ stack lineage"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-top",
      "--title",
      "Top user request",
      "--objective",
      "Restore parent combat-positioning objective",
      "--denominator",
      "combat planning residual failures",
      "--pass",
      "parent denominator rechecked after child close",
      "--next",
      "Inspect action-locked route query",
      "--path",
      "AgentQ"
    ], runtime);
    await runCommand([
      "work",
      "evidence",
      "--actor",
      actorId,
      "--evidence",
      "Initial parent context recorded."
    ], runtime);
    await runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-current",
      "--title",
      "Current interrupt",
      "--objective",
      "Verify U-turn child slice",
      "--slice",
      "U-turn chain follow regression",
      "--pass",
      "focused U-turn fixture passes",
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], runtime);

    await expect(runCommand(["work", "status", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("work stack for")
    });
    await expect(runCommand(["work", "status", "--actor", actorId], runtime)).resolves.toMatchObject({
      stdout: expect.stringContaining("AW-top [parent] Top user request")
    });
    await expect(runCommand(["next", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Stack:")
    });
    await expect(runCommand(["next", "--actor", actorId], runtime)).resolves.toMatchObject({
      stdout: expect.stringContaining("AW-current [current] Current interrupt")
    });
    const closeChild = await runCommand([
      "work",
      "close",
      "--actor",
      actorId,
      "--summary",
      "Child slice closed",
      "--evidence",
      "Focused U-turn fixture passed."
    ], runtime);
    expect(closeChild.stdout).toContain("returned to parent: AW-top");
    expect(closeChild.stdout).toContain("objective: Restore parent combat-positioning objective");
    expect(closeChild.stdout).toContain("denominator: combat planning residual failures");
    expect(closeChild.stdout).toContain("pass: parent denominator rechecked after child close");
    expect(closeChild.stdout).toContain("required: record parent-return evidence");
    expect(closeChild.stdout).toContain("next: Inspect action-locked route query");
    await expect(runCommand(["next", "--actor", actorId], runtime)).resolves.toMatchObject({
      stdout: expect.stringContaining("record parent-return evidence")
    });
    await expect(runCommand(["next", "--actor", actorId], runtime)).resolves.toMatchObject({
      stdout: expect.stringContaining("Returned from child: AW-current")
    });
    await expect(runCommand([
      "work",
      "close",
      "--actor",
      actorId,
      "--summary",
      "Parent closed without recheck"
    ], runtime)).rejects.toThrow(/parent-return evidence/);
    await expect(runCommand([
      "work",
      "evidence",
      "--actor",
      actorId,
      "--evidence",
      "Reviewed the child output."
    ], runtime)).rejects.toThrow(/parent-return evidence/);
    await expect(runCommand([
      "work",
      "close",
      "--actor",
      actorId,
      "--summary",
      "Parent closed with generic evidence",
      "--evidence",
      "Reviewed the child output."
    ], runtime)).rejects.toThrow(/parent-return evidence/);
    await runCommand([
      "work",
      "evidence",
      "--actor",
      actorId,
      "--evidence",
      "Parent return: parent denominator rechecked after child close."
    ], runtime);
    await expect(runCommand([
      "work",
      "close",
      "--actor",
      actorId,
      "--summary",
      "Parent closed after return recheck"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("closed: AW-top")
    });
  });

  it("routes non-blocking notes without gating sender or receiver done-check", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-note-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "packages/review/src/check.ts",
      "--responsibility",
      "review sender"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "packages/service/src/worker.ts",
      "--responsibility",
      "service worker owner"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await expect(runCommand([
      "note",
      "--id",
      "AQ-note",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "packages/service/src/worker.ts",
      "--summary",
      "Review evidence",
      "--note",
      "Review evidence attached; no reply required."
    ], runtime)).resolves.toEqual({
      code: 0,
      stdout: expect.stringContaining(`AQ-note noted to ${receiver}`),
      stderr: ""
    });
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 0
    });
    await expect(runCommand(["done-check", "--actor", receiver], runtime)).resolves.toMatchObject({
      code: 0
    });
    await expect(runCommand(["inbox", "--actor", receiver], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("ack: agentq respond AQ-note"),
      stderr: ""
    });
    await expect(runCommand([
      "respond",
      "AQ-note",
      "--actor",
      receiver,
      "--status",
      "resolved",
      "--evidence",
      "Acknowledged review note."
    ], runtime)).resolves.toEqual({
      code: 0,
      stdout: "AQ-note resolved\n",
      stderr: ""
    });
    await expect(runCommand(["inbox", "--actor", receiver], runtime)).resolves.toEqual({
      code: 0,
      stdout: "inbox empty\n",
      stderr: ""
    });
  });

  it("labels recent and stale actors in the actors view", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-actors-"));
    const env = { LOCALAPPDATA: path.join(workspace, "local-app-data") };
    const oldRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const recentRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T00:40:00.000Z"
    };
    const viewRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T01:01:00.000Z"
    };

    const oldActor = (await runCommand(["enter", "--as", "codex", "--session", "old"], oldRuntime)).stdout
      .trim()
      .replace(/ registered$/, "");
    const recentActor = (await runCommand(["enter", "--as", "claude-code", "--session", "recent"], recentRuntime))
      .stdout
      .trim()
      .replace(/ registered$/, "");

    const result = await runCommand(["actors"], viewRuntime);

    expect(result).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(result.stdout).toContain("actors: 2 (active 1, stale 1, staleAfter 1h)");
    expect(result.stdout).toContain(oldActor);
    expect(result.stdout).toContain(recentActor);
    expect(result.stdout).toContain("status: stale");
    expect(result.stdout).toContain("status: active");
    expect(result.stdout).toContain("age: 1h");
    expect(result.stdout).toContain("age: 21m");
  });

  it("marks broad actor scopes as weak routing evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-broad-scope-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };

    await runCommand(["enter", "--as", "codex", "--session", "broad"], runtime);
    const result = await runCommand(["actors"], runtime);

    expect(result).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(result.stdout).toContain("routing: broad; run agentq next --actor");
  });

  it("summarizes workspace queue health in the status view", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-status-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ CLI status view"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "README.md",
      "--responsibility",
      "public README"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    await runCommand(["enter", "--as", "claude-code", "--session", "idle"], runtime);

    await runCommand([
      "work",
      "start",
      "--actor",
      sender,
      "--id",
      "AW-status",
      "--title",
      "Improve status view",
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], runtime);
    await runCommand([
      "question",
      "--id",
      "AQ-status",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--question",
      "Should README mention the status view?"
    ], runtime);

    const result = await runCommand(["status"], runtime);

    expect(result).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(result.stdout).toContain("AgentQ status");
    expect(result.stdout).toContain("doctor: warn");
    expect(result.stdout).toContain("actors: 3 (active 3, stale 0, staleAfter 1h)");
    expect(result.stdout).toContain("operational active actors: 2");
    expect(result.stdout).toContain("audit/bookkeeping active actors: 1");
    expect(result.stdout).toContain("routeable active actors: 2");
    expect(result.stdout).toContain("broad/generic active actors: 0");
    expect(result.stdout).toContain("scope-refresh-needed actors: 0");
    expect(result.stdout).toContain("active work actors: 1");
    expect(result.stdout).toContain("routeable no-work actors: 1");
    expect(result.stdout).toContain("recent work-adoption nudged actors: 0");
    expect(result.stdout).toContain("ignored work-adoption nudges: 0");
    expect(result.stdout).toContain("owner-overlap nudges 24h: 0");
    expect(result.stdout).toContain("owner-message conversion 24h: none");
    expect(result.stdout).toContain("broad presence-only actors: 1");
    expect(result.stdout).toContain("codex: total 1, active 1, stale 0, operational-active 1, bookkeeping-active 0, routeable 1, broad/generic 0, scope-refresh-needed 0, active-work 1, routeable-no-work 0, broad-presence-only 0");
    expect(result.stdout).toContain("claude-code: total 2, active 2, stale 0, operational-active 1, bookkeeping-active 1, routeable 1, broad/generic 0, scope-refresh-needed 0, active-work 0, routeable-no-work 1, broad-presence-only 1");
    expect(result.stdout).toContain("pending inbox: 1");
    expect(result.stdout).toContain("open work: 1");
    expect(result.stdout).toContain("orphan open work: 0");
    expect(result.stdout).toContain("zero-evidence open work: 1");
    expect(result.stdout).toContain("started-only stale work: 0");
    expect(result.stdout).toContain("Zero-evidence open work:");
    expect(result.stdout).toContain(`next: agentq next --actor ${sender}`);
    expect(result.stdout).toContain("Next:");
    expect(result.stdout).toContain("Signals:");
    expect(result.stdout).not.toContain("Recommendations:");
    expect(result.stdout).toContain("zero-evidence-work: 1 open work item(s) have no context evidence.");
    expect(result.stdout).toContain("bookkeeping-presence: 1 broad presence-only actor(s) are audit/session context.");
    expect(result.stdout).toContain("agentq next --actor <id>");
    expect(result.stdout).toContain("recent messages 24h: 1");
    expect(result.stdout).toContain("weak-scope actors: 1");
    expect(result.stdout).toContain("Operational active actors:");
    expect(result.stdout).toContain("Audit/bookkeeping active actors:");
    expect(result.stdout).toContain("AW-status");
    expect(result.stdout).toContain("AQ-status");
  });

  it("reports owner-overlap signals that did not turn into messages", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-status-owner-conversion-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:10:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "owner-conversion",
      "--paths",
      "README.md",
      "--responsibility",
      "Owner overlap conversion diagnostics"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "owner-peer",
      "--paths",
      "README.md",
      "--responsibility",
      "README ownership"
    ], runtime);
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:09:00.000Z",
      actorId,
      event: "pre-tool",
      toolName: "Bash",
      toolMode: "mutating",
      paths: ["README.md"],
      nudge: true,
      nudgeKinds: ["owner-overlap"]
    });

    const status = await runCommand(["status"], runtime);

    expect(status.stdout).toContain("owner-overlap nudges 24h: 1");
    expect(status.stdout).toContain("owner-message conversion 24h: missing");
    expect(status.stdout).toContain("recent messages 24h: 0");
    expect(status.stdout).toContain("coordination-conversion: 1 owner-overlap nudge(s), but no recent inter-agent messages.");
  });

  it("reports orphan active work pointers that have no actor presence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-status-orphan-work-"));
    const env = { LOCALAPPDATA: path.join(workspace, "local-app-data") };
    const actorId = "codex@superlazy@orphan-smoke@123456";
    const startRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const viewRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T02:00:00.000Z"
    };

    const store = await resolveWorkspaceStore(workspace, { env });
    await startWork(store, {
      actorId,
      workId: "AW-orphan-smoke",
      title: "Install smoke",
      paths: ["AgentQ/scripts/package-smoke.ts"],
      now: startRuntime.now()
    });

    const result = await runCommand(["status"], viewRuntime);

    expect(result).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(result.stdout).toContain("actors: 0");
    expect(result.stdout).toContain("open work: 1");
    expect(result.stdout).toContain("orphan open work: 1");
    expect(result.stdout).toContain("stale open work: 1");
    expect(result.stdout).toContain("zero-evidence open work: 1");
    expect(result.stdout).toContain("started-only stale work: 1");
    expect(result.stdout).toContain("Orphan open work:");
    expect(result.stdout).toContain("actorPresence: missing");
    expect(result.stdout).toContain("events: 1");
    expect(result.stdout).toContain("Started-only stale work:");
    expect(result.stdout).toContain("started-only-stale-work: 1 item(s) look like interrupted sessions or smoke residue.");
  });

  it("reports terminal active work pointers without counting them as open active work", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-status-terminal-pointer-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:10:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "terminal-pointer",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ status accounting"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await startWork(store, {
      actorId,
      workId: "AW-terminal-pointer",
      title: "Closed pointer residue",
      paths: ["AgentQ/packages/cli/src/main.ts"],
      now: "2026-05-18T00:00:00.000Z"
    });
    await appendWorkEvidence(store, {
      actorId,
      evidence: ["Terminal pointer fixture has close evidence."],
      now: "2026-05-18T00:01:00.000Z"
    });
    await closeWork(store, {
      actorId,
      workId: "AW-terminal-pointer",
      summary: "Closed but legacy pointer restored for status accounting.",
      evidence: [],
      now: "2026-05-18T00:02:00.000Z"
    });
    await writeAtomicYaml(store.layout.actorWorkPointerPath(actorId), {
      actorId,
      activeWorkId: "AW-terminal-pointer",
      updatedAt: "2026-05-18T00:03:00.000Z"
    });

    const result = await runCommand(["status"], runtime);

    expect(result).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(result.stdout).toContain("active work actors: 0");
    expect(result.stdout).toContain("open work: 0");
    expect(result.stdout).toContain("terminal active work pointers: 1");
    expect(result.stdout).toContain("Terminal active work pointers:");
    expect(result.stdout).toContain("status: closed");

    const cleanup = await runCommand(["work", "cleanup-stale", "--yes"], runtime);
    expect(cleanup.stdout).toContain("terminal pointers cleared: 1");
    expect(await readActiveWorkState(store, actorId)).toBeNull();
  });

  it("previews and abandons only started-only stale work residue", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-work-cleanup-stale-"));
    const env = { LOCALAPPDATA: path.join(workspace, "local-app-data") };
    const staleActor = "codex@superlazy@cleanup-stale@123456";
    const evidencedActor = "codex@superlazy@cleanup-evidenced@123456";
    const activeRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T02:00:00.000Z"
    };
    const viewRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T03:00:00.000Z"
    };

    const store = await resolveWorkspaceStore(workspace, { env });
    await startWork(store, {
      actorId: staleActor,
      workId: "AW-cleanup-stale",
      title: "Interrupted install smoke",
      paths: ["AgentQ/scripts/package-smoke.ts"],
      now: "2026-05-18T00:00:00.000Z"
    });
    await startWork(store, {
      actorId: evidencedActor,
      workId: "AW-cleanup-evidenced",
      title: "Evidenced stale investigation",
      paths: ["AgentQ/packages/core/src/work/workStack.ts"],
      now: "2026-05-18T00:00:00.000Z"
    });
    await appendWorkEvidence(store, {
      actorId: evidencedActor,
      evidence: ["Evidence exists, so stale cleanup must leave this work for manual review."],
      now: "2026-05-18T00:01:00.000Z"
    });
    const activeActor = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "active-cleanup",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "Active cleanup implementation"
    ], activeRuntime)).stdout.trim().replace(/ registered$/, "");
    await runCommand([
      "work",
      "start",
      "--actor",
      activeActor,
      "--id",
      "AW-cleanup-active",
      "--title",
      "Fresh active implementation",
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], activeRuntime);

    const preview = await runCommand(["work", "cleanup-stale"], viewRuntime);

    expect(preview).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(preview.stdout).toContain("Mode: dry-run");
    expect(preview.stdout).toContain("candidates: 1");
    expect(preview.stdout).toContain("AW-cleanup-stale");
    expect(preview.stdout).not.toContain("AW-cleanup-evidenced");
    expect(preview.stdout).not.toContain("AW-cleanup-active");
    expect((await readActiveWorkState(store, staleActor))?.workId).toBe("AW-cleanup-stale");

    const applied = await runCommand(["work", "cleanup-stale", "--yes"], viewRuntime);

    expect(applied).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(applied.stdout).toContain("Mode: applied");
    expect(applied.stdout).toContain("candidates: 1");
    expect(applied.stdout).toContain("abandoned: 1");
    expect(await readActiveWorkState(store, staleActor)).toBeNull();
    expect((await readActiveWorkState(store, evidencedActor))?.workId).toBe("AW-cleanup-evidenced");
    expect((await readActiveWorkState(store, activeActor))?.workId).toBe("AW-cleanup-active");

    const status = await runCommand(["status"], viewRuntime);
    expect(status.stdout).toContain("open work: 2");
    expect(status.stdout).toContain("orphan open work: 1");
    expect(status.stdout).toContain("started-only stale work: 0");
  });

  it("prompts active work after a recent concrete edit nudge", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-next-nudge-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:10:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "nudge",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ CLI adoption diagnostics"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:09:00.000Z",
      actorId,
      event: "pre-tool",
      toolName: "apply_patch",
      paths: ["AgentQ/packages/cli/src/main.ts"],
      nudge: true,
      nudgeKinds: ["work-adoption"]
    });

    const next = await runCommand(["next", "--actor", actorId], runtime);
    expect(next).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(next.stdout).toContain("Action: start or confirm active work before continuing.");
    expect(next.stdout).toContain("Recent work-adoption nudge: 1");
    expect(next.stdout).toContain("agentq work start --actor");

    const status = await runCommand(["status"], runtime);
    const activity = await runCommand(["diag", "activity", "--window", "1h"], runtime);
    expect(status.stdout).toContain("recent work-adoption nudged actors: 1");
    expect(status.stdout).toContain("blocked work-adoption attempts: 0");
    expect(status.stdout).toContain("resolved blocked work-adoption attempts: 0");
    expect(status.stdout).toContain("unresolved blocked work-adoption attempts: 0");
    expect(status.stdout).toContain("ignored work-adoption nudges: 1");
    expect(status.stdout).toContain("Next:");
    expect(status.stdout).toContain("Start active work for actors that already received concrete edit nudges");
    expect(status.stdout).toContain("work-adoption: 1 actor(s) received edit nudges without active work.");
    expect(status.stdout).not.toContain("Recommendations:");
    expect(activity.stdout).toContain("ignoredWorkNudges:1");
    expect(activity.stdout).toContain("unresolvedBlockedWork:0");
    expect(activity.stdout).toContain("diagnosis:shared-goal-context-missing");
    expect(activity.stdout).not.toContain("diagnosis:policy-work-adoption-unresolved");
  });

  it("does not label blocked work-adoption attempts as ignored", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-next-blocked-nudge-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:10:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "blocked-nudge",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ CLI blocked adoption diagnostics"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:09:00.000Z",
      actorId,
      event: "pre-tool",
      toolName: "apply_patch",
      toolMode: "mutating",
      paths: ["AgentQ/packages/cli/src/main.ts"],
      nudge: true,
      nudgeKinds: ["work-adoption"],
      decision: "block"
    });

    const status = await runCommand(["status"], runtime);
    const activity = await runCommand(["diag", "activity", "--window", "1h"], runtime);

    expect(status.stdout).toContain("recent work-adoption nudged actors: 1");
    expect(status.stdout).toContain("blocked work-adoption attempts: 1");
    expect(status.stdout).toContain("resolved blocked work-adoption attempts: 0");
    expect(status.stdout).toContain("unresolved blocked work-adoption attempts: 1");
    expect(status.stdout).toContain("ignored work-adoption nudges: 0");
    expect(status.stdout).toContain("work-adoption-blocked: 1 actor(s) still have unresolved blocked mutating attempts.");
    expect(status.stdout).not.toContain("work-adoption: 1 actor(s) received edit nudges without active work.");
    expect(activity.stdout).toContain("unresolvedBlockedWork:1");
    expect(activity.stdout).toContain("diagnosis:shared-goal-context-blocked");
    expect(activity.stdout).not.toContain("diagnosis:policy-work-adoption-unresolved");
  });

  it("reports blocked work-adoption attempts as resolved after work starts", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-resolved-blocked-nudge-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:10:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "resolved-blocked-nudge",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ resolved blocked adoption diagnostics"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:01:00.000Z",
      actorId,
      event: "pre-tool",
      toolName: "apply_patch",
      toolMode: "mutating",
      paths: ["AgentQ/packages/cli/src/main.ts"],
      nudge: true,
      nudgeKinds: ["work-adoption"],
      decision: "block"
    });
    await runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-resolved-blocked-nudge",
      "--title",
      "Resolved blocked adoption",
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], { ...runtime, now: () => "2026-05-18T00:02:00.000Z" });

    const status = await runCommand(["status"], runtime);
    const activity = await runCommand(["diag", "activity", "--window", "1h"], runtime);

    expect(status.stdout).toContain("recent work-adoption nudged actors: 1");
    expect(status.stdout).toContain("blocked work-adoption attempts: 1");
    expect(status.stdout).toContain("resolved blocked work-adoption attempts: 1");
    expect(status.stdout).toContain("unresolved blocked work-adoption attempts: 0");
    expect(status.stdout).not.toContain("work-adoption-blocked: 1 actor(s) still have unresolved blocked mutating attempts.");
    expect(activity.stdout).toContain("blockedWorkNudges:1");
    expect(activity.stdout).toContain("blockedWorkResolved");
    expect(activity.stdout).not.toContain("blockedWorkUnresolved");
    expect(activity.stdout).toContain("unresolvedBlockedWork:0");
    expect(activity.stdout).not.toContain("diagnosis:policy-work-adoption-unresolved");
  });

  it("does not label a completed post-nudge work adoption as ignored", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-resolved-nudge-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:10:00.000Z"
    };
    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "resolved-nudge",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ resolved adoption diagnostics"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const store = await resolveWorkspaceStore(workspace, { env: runtime.env });
    await appendDiagnosticEvent(store, {
      kind: "hook",
      at: "2026-05-18T00:01:00.000Z",
      actorId,
      event: "pre-tool",
      toolName: "apply_patch",
      toolMode: "mutating",
      paths: ["AgentQ/packages/cli/src/main.ts"],
      nudge: true,
      nudgeKinds: ["work-adoption"]
    });
    await runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-resolved-nudge",
      "--title",
      "Resolved adoption",
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], { ...runtime, now: () => "2026-05-18T00:02:00.000Z" });
    await runCommand([
      "work",
      "evidence",
      "--actor",
      actorId,
      "--evidence",
      "Context recorded after adoption nudge."
    ], { ...runtime, now: () => "2026-05-18T00:03:00.000Z" });
    await runCommand([
      "work",
      "close",
      "--actor",
      actorId,
      "--summary",
      "Resolved adoption closed."
    ], { ...runtime, now: () => "2026-05-18T00:04:00.000Z" });

    const status = await runCommand(["status"], runtime);

    expect(status.stdout).toContain("recent work-adoption nudged actors: 1");
    expect(status.stdout).toContain("blocked work-adoption attempts: 0");
    expect(status.stdout).toContain("resolved blocked work-adoption attempts: 0");
    expect(status.stdout).toContain("unresolved blocked work-adoption attempts: 0");
    expect(status.stdout).toContain("ignored work-adoption nudges: 0");
    expect(status.stdout).not.toContain("work-adoption: 1 actor(s) received edit nudges without active work.");
  });

  it("classifies legacy noisy paths as scope refresh instead of routeable no-work", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-status-noisy-path-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:10:00.000Z"
    };
    await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "noisy-path",
      "--paths",
      "+AGENTS.md",
      "--paths",
      "Shared/.gitignore\"",
      "--paths",
      "Shared/.codegraph/codegraph.db).Length",
      "--responsibility",
      "Loop snapshot eval"
    ], runtime);

    const status = await runCommand(["status"], runtime);

    expect(status.stdout).toContain("routeable active actors: 0");
    expect(status.stdout).toContain("scope-refresh-needed actors: 1");
    expect(status.stdout).toContain("legacy/noisy path actors: 1");
    expect(status.stdout).toContain("routeable no-work actors: 0");
    expect(status.stdout).toContain("scope-refresh: 1 weak-scoped actor(s) also have inbox, work, nudges, or noisy paths.");
    expect(status.stdout).toContain("noisy_path");
  });

  it("finds active path owners and excludes the current actor when requested", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-owners-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ CLI status view"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "AgentQ/packages/cli/src",
      "--responsibility",
      "AgentQ CLI source owner"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const bookkeeping = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "bookkeeping",
      "--paths",
      "AgentQ/packages/cli/src",
      "--responsibility",
      "codex session"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    const result = await runCommand([
      "owners",
      "--actor",
      sender,
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], runtime);

    expect(result).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(result.stdout).toContain(`owners for AgentQ/packages/cli/src/main.ts:`);
    expect(result.stdout).toContain(receiver);
    expect(result.stdout).not.toContain(bookkeeping);
    expect(result.stdout).not.toContain(`  ${sender} |`);
    expect(result.stdout).toContain("Ownership is a routing signal, not a lock");
    expect(result.stdout).toContain("agentq question --actor <your-actor-id>");

    const routed = await runCommand([
      "question",
      "--id",
      "AQ-owner-bookkeeping",
      "--actor",
      sender,
      "--path",
      "AgentQ/packages/cli/src/main.ts",
      "--question",
      "Can I edit main?",
      "--expect",
      "Answer with active ownership evidence"
    ], runtime);
    expect(routed.stdout).toContain(`AQ-owner-bookkeeping routed to ${receiver}`);
    expect(routed.stdout).not.toContain(bookkeeping);
  });

  it("rejects state --paths while suggesting the owner-routing command", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-state-recovery-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "AgentQ/packages/cli/src/main.ts",
      "--responsibility",
      "AgentQ CLI status view"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const result = await runCommand([
      "state",
      "--actor",
      sender,
      "--paths",
      "AgentQ/packages/cli/src/main.ts"
    ], runtime);

    expect(result).toMatchObject({
      code: 2,
      stdout: ""
    });
    expect(result.stderr).toContain("agentq: unknown command: state");
    expect(result.stderr).toContain("State is not an AgentQ command");
    expect(result.stderr).toContain(`agentq owners --path AgentQ/packages/cli/src/main.ts --actor ${sender}`);
    expect(result.stderr).toContain("Path/resource queries are owner routing");
  });

  it("accepts enter --path so a guessed singular option does not register broad scope", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-enter-path-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };

    const actorId = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--path",
      "ProjectDD/DD.Shared",
      "--responsibility",
      "ProjectDD owner"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    const actors = await runCommand(["actors"], runtime);
    const next = await runCommand(["next", "--actor", actorId], runtime);

    expect(actors.stdout).toContain("paths: ProjectDD/DD.Shared");
    expect(next.stdout).not.toContain("broad_path");
  });

  it("accepts --paths on owners and question for path option consistency", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-paths-consistency-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "ProjectDD/DD.Shared",
      "--responsibility",
      "sender"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      "ProjectDD",
      "--responsibility",
      "receiver"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    const owners = await runCommand([
      "owners",
      "--actor",
      sender,
      "--paths",
      "ProjectDD/DD.Shared"
    ], runtime);
    const question = await runCommand([
      "question",
      "--actor",
      sender,
      "--to",
      receiver,
      "--question",
      "Can I edit?",
      "--paths",
      "ProjectDD/DD.Shared"
    ], runtime);

    expect(owners).toMatchObject({ code: 0, stderr: "" });
    expect(owners.stdout).toContain(receiver);
    expect(question).toMatchObject({ code: 0, stderr: "" });
    expect(question.stdout).toContain("routed");
  });

  it("adds actor-id recovery guidance when --actor is omitted", async () => {
    await expect(runCommand(["next"]))
      .rejects.toThrow(/missing required option --actor.*agentq next --actor <id>/);
  });

  it("finds and routes owners from absolute workspace paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-absolute-owners-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "src/consumer.ts",
      "--responsibility",
      "consumer"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const readmePath = path.join(workspace, "AgentQ", "README.md");
    const docsPath = path.join(workspace, "AgentQ", "docs");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "receiver",
      "--paths",
      `${readmePath},${docsPath}`,
      "--responsibility",
      "AgentQ public docs"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    const owners = await runCommand([
      "owners",
      "--actor",
      sender,
      "--path",
      readmePath
    ], runtime);
    const question = await runCommand([
      "question",
      "--id",
      "AQ-absolute-owner",
      "--actor",
      sender,
      "--path",
      "AgentQ/docs/focused-product-validation.md",
      "--question",
      "Can I change the focused validation doc?",
      "--expect",
      "Answer with active doc ownership evidence."
    ], runtime);

    expect(owners.stdout).toContain(receiver);
    expect(question.stdout).toContain(`AQ-absolute-owner routed to ${receiver}`);
  });

  it("refreshes exact actor presence when work starts", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-work-refresh-"));
    const env = { LOCALAPPDATA: path.join(workspace, "local-app-data") };
    const oldRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const workRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T01:02:00.000Z"
    };
    const viewRuntime = {
      cwd: workspace,
      env,
      now: () => "2026-05-18T01:03:00.000Z"
    };
    const actorId = (await runCommand(["enter", "--as", "codex", "--session", "refresh"], oldRuntime))
      .stdout
      .trim()
      .replace(/ registered$/, "");

    await runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--title",
      "Improve status view",
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], workRuntime);

    const result = await runCommand(["actors"], viewRuntime);

    expect(result.stdout).toContain("actors: 1 (active 1, stale 0, staleAfter 1h)");
    expect(result.stdout).toContain("age: 1m");
    expect(result.stdout).toContain("paths: AgentQ/packages/cli/src/main.ts");
    expect(result.stdout).toContain("responsibilities: Improve status view");
  });

});
