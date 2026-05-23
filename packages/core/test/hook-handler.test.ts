import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRoutedBlocker,
  createOrRefreshSessionBinding,
  ensureWorkspaceStore,
  listActorPresences,
  resolveWorkspaceStore,
  runHookHandler,
  createAdapterSessionKey,
  appendWorkEvidence,
  closeWork,
  readActiveWorkState,
  startWork,
  type Message
} from "../src/index.js";

describe("AgentQ hook handler", () => {
  it("registers a session and blocks Stop while a required reply is open", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-hook-handler-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const env = testEnv(tempRoot);
    const payload = {
      session_id: "S1",
      cwd: workspace,
      hook_event_name: "SessionStart"
    };

    const start = await runHookHandler({
      adapter: "codex",
      event: "session-start",
      payload,
      env,
      now: "2026-05-18T00:00:00.000Z"
    });
    expect(start.stdout).toContain("AgentQ actor id:");
    const actorId = actorIdFromContext(start.stdout);

    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    const message: Message = {
      id: "AQ-1",
      kind: "blocker",
      createdBy: "codex@sender",
      summary: "Need answer",
      paths: ["."],
      contracts: [],
      passCriteria: ["reply"],
      observed: "blocked",
      brokenContract: "required reply"
    };
    await createRoutedBlocker(store, {
      message,
      explicitTo: [actorId],
      now: "2026-05-18T00:00:01.000Z",
      staleAfterMs: 300000
    });

    const stop = await runHookHandler({
      adapter: "codex",
      event: "stop",
      payload: { ...payload, hook_event_name: "Stop", stop_hook_active: false },
      env,
      now: "2026-05-18T00:00:02.000Z"
    });

    expect(stop.code).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({ decision: "block" });
  });

  it("updates active paths from a mutating pre-tool hook before routing blockers", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-pre-tool-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);
    const payload = {
      session_id: "S2",
      cwd: workspace,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "src/protocol.ts"
      }
    };

    const result = await runHookHandler({
      adapter: "claude-code",
      event: "pre-tool",
      payload,
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    const store = await resolveWorkspaceStore(workspace, { env });
    const session = await readFile(
      store.layout.sessionPath(createAdapterSessionKey("claude-code", "S2")),
      "utf8"
    );
    const actorId = actorIdFromSession(session);
    const presence = await readFile(store.layout.actorPresencePath(actorId), "utf8");
    expect(presence).toContain("src/protocol.ts");
  });

  it("bootstraps a missing session binding from Stop for already-running sessions", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-stop-bootstrap-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);

    const stop = await runHookHandler({
      adapter: "codex",
      event: "stop",
      payload: {
        session_id: "S3",
        cwd: workspace,
        hook_event_name: "Stop",
        tool_input: {
          file_path: "src/late-session.ts"
        },
        stop_hook_active: false
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(stop.code).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("scope-check failed")
    });

    const store = await resolveWorkspaceStore(workspace, { env });
    const session = await readFile(
      store.layout.sessionPath(createAdapterSessionKey("codex", "S3")),
      "utf8"
    );
    const actorId = actorIdFromSession(session);
    expect(actorId).toContain("@s3@");
    expect(actorId).not.toContain("stop-gate");
    const presence = await readFile(store.layout.actorPresencePath(actorId), "utf8");
    expect(presence).toContain("src/late-session.ts");
  });

  it("blocks Stop while the actor has active internal work", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-work-stop-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);
    const payload = {
      session_id: "S4",
      cwd: workspace,
      hook_event_name: "SessionStart"
    };

    const start = await runHookHandler({
      adapter: "codex",
      event: "session-start",
      payload,
      env,
      now: "2026-05-18T00:00:00.000Z"
    });
    const actorId = actorIdFromContext(start.stdout);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    await startWork(store, {
      actorId,
      workId: "AW-hook",
      title: "Hook-gated internal work",
      paths: ["src/protocol.ts"],
      now: "2026-05-18T00:00:01.000Z"
    });

    const blocked = await runHookHandler({
      adapter: "codex",
      event: "stop",
      payload: {
        ...payload,
        hook_event_name: "Stop",
        tool_input: { file_path: "src/protocol.ts" },
        stop_hook_active: false
      },
      env,
      now: "2026-05-18T00:00:02.000Z"
    });
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("work-check failed")
    });

    await appendWorkEvidence(store, {
      actorId,
      evidence: ["hook work stop test evidence"],
      now: "2026-05-18T00:00:03.000Z"
    });
    await closeWork(store, {
      actorId,
      summary: "Hook work closed",
      evidence: [],
      now: "2026-05-18T00:00:04.000Z"
    });
    const passed = await runHookHandler({
      adapter: "codex",
      event: "stop",
      payload: {
        ...payload,
        hook_event_name: "Stop",
        stop_hook_active: false
      },
      env,
      now: "2026-05-18T00:00:05.000Z"
    });
    expect(passed.stdout).toBe("{}\n");
  });

  it("does not record whole shell commands as touched paths", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-work-paths-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);

    const start = await runHookHandler({
      adapter: "codex",
      event: "session-start",
      payload: {
        session_id: "S5",
        cwd: workspace,
        hook_event_name: "SessionStart"
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });
    const actorId = actorIdFromContext(start.stdout);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    await startWork(store, {
      actorId,
      workId: "AW-paths",
      title: "Path extraction",
      paths: ["src/protocol.ts"],
      now: "2026-05-18T00:00:01.000Z"
    });

    await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S5",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "shell_command",
        tool_input: {
          command: "pwsh -NoProfile -Command 'Get-Content AgentQ/README.md'"
        }
      },
      env,
      now: "2026-05-18T00:00:02.000Z"
    });

    const active = await readActiveWorkState(store, actorId);
    expect(active?.touchedPaths.join("\n")).not.toContain("pwsh -NoProfile");
    const session = await readFile(
      store.layout.sessionPath(createAdapterSessionKey("codex", "S5")),
      "utf8"
    );
    const presence = await readFile(store.layout.actorPresencePath(actorIdFromSession(session)), "utf8");
    expect(presence).toContain("src/protocol.ts");
    expect(presence).toContain("Path extraction");
    expect(presence).not.toContain("activePaths:\n  - .");
  });

  it("keeps read-only pre-tool paths as observed scope", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-idle-paths-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);

    await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S6",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: {
          file_path: "src/specific.ts"
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });
    await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S6",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "shell_command",
        tool_input: {
          command: "pwsh -NoProfile -Command 'agentq actors'"
        }
      },
      env,
      now: "2026-05-18T00:01:00.000Z"
    });

    const store = await resolveWorkspaceStore(workspace, { env });
    const session = await readFile(
      store.layout.sessionPath(createAdapterSessionKey("codex", "S6")),
      "utf8"
    );
    const presence = await readFile(store.layout.actorPresencePath(actorIdFromSession(session)), "utf8");
    expect(presence).toContain("observedPaths:");
    expect(presence).toContain("src/specific.ts");
    expect(presence).toContain("activePaths:\n  - .");
  });

  it("adds a non-blocking owner nudge on mutating pre-tool overlap", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-owner-nudge-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    const owner = await createOrRefreshSessionBinding(store, {
      adapter: "claude-code",
      sessionId: "owner",
      cwd: workspace,
      activePaths: ["src/protocol.ts"],
      responsibilities: ["protocol owner"],
      summary: "protocol owner",
      now: "2026-05-18T00:00:00.000Z"
    });

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S7",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: "src/protocol.ts"
        }
      },
      env,
      now: "2026-05-18T00:00:01.000Z"
    });

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      readonly hookSpecificOutput?: { readonly additionalContext?: string };
    };
    expect(output.hookSpecificOutput?.additionalContext).toContain("related active actor");
    expect(output.hookSpecificOutput?.additionalContext).toContain(owner.actorId);
    expect(output.hookSpecificOutput?.additionalContext).toContain("agentq question --actor");
  });

  it("does not nudge on read-only pre-tool overlap", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-owner-read-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    await createOrRefreshSessionBinding(store, {
      adapter: "claude-code",
      sessionId: "owner",
      cwd: workspace,
      activePaths: ["src/protocol.ts"],
      responsibilities: ["protocol owner"],
      summary: "protocol owner",
      now: "2026-05-18T00:00:00.000Z"
    });

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S8",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: {
          file_path: "src/protocol.ts"
        }
      },
      env,
      now: "2026-05-18T00:00:01.000Z"
    });

    expect(result.stdout).toBe("{}\n");
  });

  it("preserves concrete responsibility when idle pre-tool refreshes paths", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-pre-tool-preserve-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    const binding = await createOrRefreshSessionBinding(store, {
      adapter: "codex",
      sessionId: "S9",
      cwd: workspace,
      activePaths: ["src/specific.ts"],
      responsibilities: ["specific owner"],
      summary: "specific owner",
      now: "2026-05-18T00:00:00.000Z"
    });

    await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S9",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: "src/specific.ts"
        }
      },
      env,
      now: "2026-05-18T00:00:01.000Z"
    });

    const presence = await readFile(store.layout.actorPresencePath(binding.actorId), "utf8");
    expect(presence).toContain("specific owner");
    expect(presence).not.toContain("active tool scope");
  });

  it("merges idle pre-tool paths instead of replacing concrete scope", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-pre-tool-merge-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    const binding = await createOrRefreshSessionBinding(store, {
      adapter: "codex",
      sessionId: "S10",
      cwd: workspace,
      activePaths: ["src/first.ts"],
      responsibilities: ["specific owner"],
      summary: "specific owner",
      now: "2026-05-18T00:00:00.000Z"
    });

    await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S10",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: "src/second.ts"
        }
      },
      env,
      now: "2026-05-18T00:00:01.000Z"
    });

    const presence = await readFile(store.layout.actorPresencePath(binding.actorId), "utf8");
    expect(presence).toContain("src/first.ts");
    expect(presence).toContain("src/second.ts");
    expect(presence).toContain("specific owner");
  });

  it("keeps one deterministic actor for concurrent pre-tool hooks in one session", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-pre-tool-concurrent-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) =>
        await runHookHandler({
          adapter: "codex",
          event: "pre-tool",
          payload: {
            session_id: "S11",
            cwd: workspace,
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            tool_input: {
              file_path: `src/file-${index}.ts`
            }
          },
          env,
          now: `2026-05-18T00:00:${String(index).padStart(2, "0")}.000Z`
        })
      )
    );

    const store = await resolveWorkspaceStore(workspace, { env });
    const actors = await listActorPresences(store);
    expect(actors).toHaveLength(1);
    expect(actors[0]?.actorId).toContain("@s11@");
  });
});

function actorIdFromContext(stdout: string): string {
  const match = stdout.match(/AgentQ actor id: ([^.]+)\./);
  if (match?.[1] === undefined) {
    throw new Error(`No actor id in hook output: ${stdout}`);
  }

  return match[1];
}

function testEnv(tempRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: tempRoot,
    XDG_STATE_HOME: path.join(tempRoot, "state"),
    LOCALAPPDATA: path.join(tempRoot, "local-app-data")
  };
}

function actorIdFromSession(content: string): string {
  const match = content.match(/^actorId: (.+)$/m);
  if (match?.[1] === undefined) {
    throw new Error(`No actor id in session binding: ${content}`);
  }

  return match[1];
}
