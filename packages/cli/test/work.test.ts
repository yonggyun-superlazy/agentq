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

    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("work-check failed")
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

});
