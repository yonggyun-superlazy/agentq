import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { foldMessageState, resolveWorkspaceStore } from "@agentq/core";
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
      stderr: expect.stringContaining("0 evidence")
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
      stderr: expect.stringContaining("outbound_pending")
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
      stderr: expect.stringContaining("outbound_pending")
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
      stderr: expect.stringContaining("scope-check failed")
    });
    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("scope-check failed")
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
      stderr: expect.stringContaining("outbound_pending")
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
    await expect(runCommand(["next", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Action: wait for the required reply")
    });

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
    expect(result.stdout).toContain("routing: broad; refresh this actor with agentq enter --actor");
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
    expect(result.stdout).toContain("actors: 2 (active 2, stale 0, staleAfter 1h)");
    expect(result.stdout).toContain("routeable active actors: 2");
    expect(result.stdout).toContain("broad/generic active actors: 0");
    expect(result.stdout).toContain("pending inbox: 1");
    expect(result.stdout).toContain("open work: 1");
    expect(result.stdout).toContain("zero-evidence open work: 1");
    expect(result.stdout).toContain("Open work without context evidence remains");
    expect(result.stdout).toContain("recent messages 24h: 1");
    expect(result.stdout).toContain("weak-scope actors: 0");
    expect(result.stdout).toContain("AW-status");
    expect(result.stdout).toContain("AQ-status");
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
    expect(result.stdout).not.toContain(`  ${sender} |`);
    expect(result.stdout).toContain("Ownership is a routing signal, not a lock");
    expect(result.stdout).toContain("agentq question --actor <your-actor-id>");
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
