import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRoutedBlocker,
  createOrRefreshSessionBinding,
  ensureWorkspaceStore,
  listActorPresences,
  readDiagnosticEvents,
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
  it("skips hooks with missing runtime identity instead of failing the agent stop", async () => {
    for (const event of ["session-start", "pre-tool", "stop"] as const) {
      const result = await runHookHandler({
        adapter: "codex",
        event,
        payload: {},
        env: testEnv(await mkdtemp(path.join(os.tmpdir(), "agentq-hook-missing-identity-"))),
        now: "2026-05-18T00:00:00.000Z"
      });

      expect(result).toEqual({
        code: 0,
        stdout: "{}\n",
        stderr: "agentq: hook payload missing cwd or session id; skipping AgentQ hook.\n"
      });
    }
  });

  it("uses Codex runtime fallbacks and namespaced tool names when hook payloads omit legacy fields", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-hook-runtime-fallback-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        toolName: "functions.apply_patch",
        toolInput: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/protocol.ts",
            "@@",
            "-old",
            "+new",
            "*** End Patch"
          ].join("\n")
        }
      },
      defaultCwd: workspace,
      defaultSessionId: "S-runtime-fallback",
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block" });

    const store = await resolveWorkspaceStore(workspace, { env });
    const session = await readFile(
      store.layout.sessionPath(createAdapterSessionKey("codex", "S-runtime-fallback")),
      "utf8"
    );
    const actorId = actorIdFromSession(session);
    const presence = await readFile(store.layout.actorPresencePath(actorId), "utf8");
    expect(presence).toContain("src/protocol.ts");
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]).toMatchObject({
      toolName: "functions.apply_patch",
      paths: ["src/protocol.ts"],
      toolMode: "mutating",
      decision: "block"
    });
  });

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
    expect(start.stdout).toContain("Shared-work id for edits/handoffs only:");
    expect(start.stdout).toContain("Short read-only answers");
    expect(start.stdout).toContain("can answer directly");
    expect(start.stdout).toContain("[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]");
    expect(start.stdout).toContain("Internal shared-work maintenance");
    expect(start.stdout).toContain("latest requested artifact first");
    expect(start.stdout).toContain("Hide internal ids, command names");
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
    expect(JSON.parse(stop.stdout).reason).toContain("[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]");
    expect(JSON.parse(stop.stdout).reason).toContain("Do not use this maintenance status as the user-facing answer");
    expect(JSON.parse(stop.stdout).reason).toContain("latest requested artifact first");
    expect(JSON.parse(stop.stdout).reason).toContain("Hide internal ids, command names");

    // Retry of the same stop attempt (stop_hook_active=true) must not re-block:
    // the unresolved reply depends on another actor, and repeated blocks only
    // trigger the harness force-override loop guard.
    const stopRetry = await runHookHandler({
      adapter: "codex",
      event: "stop",
      payload: { ...payload, hook_event_name: "Stop", stop_hook_active: true },
      env,
      now: "2026-05-18T00:00:03.000Z"
    });
    expect(stopRetry.code).toBe(0);
    expect(JSON.parse(stopRetry.stdout).decision).toBeUndefined();
  });

  it("supports compact, full, and off SessionStart context modes", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-session-context-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const env = testEnv(tempRoot);
    const payload = {
      session_id: "S1",
      cwd: workspace,
      hook_event_name: "SessionStart"
    };

    const compact = await runHookHandler({
      adapter: "codex",
      event: "session-start",
      payload,
      env,
      now: "2026-05-18T00:00:00.000Z"
    });
    expect(compact.stdout).toContain("Shared-work id for edits/handoffs only:");
    expect(compact.stdout).toContain("agentq next --actor");
    expect(compact.stdout).toContain("[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]");
    expect(compact.stdout).toContain("latest requested artifact first");
    expect(compact.stdout).toContain("Hide internal ids, command names");
    expect(compact.stdout.split("\n").length).toBeLessThanOrEqual(16);

    const full = await runHookHandler({
      adapter: "codex",
      event: "session-start",
      payload: { ...payload, session_id: "S2" },
      env: { ...env, AGENTQ_SESSION_START_CONTEXT: "full" },
      now: "2026-05-18T00:00:01.000Z"
    });
    expect(full.stdout).toContain("Internal shared-work id:");
    expect(full.stdout).toContain("agentq next --actor");
    expect(full.stdout).toContain("[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]");
    expect(full.stdout).toContain("latest requested artifact first");
    expect(full.stdout).toContain("Hide internal ids, command names");

    const off = await runHookHandler({
      adapter: "codex",
      event: "session-start",
      payload: { ...payload, session_id: "S3" },
      env: { ...env, AGENTQ_SESSION_START_CONTEXT: "off" },
      now: "2026-05-18T00:00:02.000Z"
    });
    expect(off.stdout).toContain("Shared-work note:");
    expect(off.stdout).not.toContain("agentq next --actor");
    expect(off.stdout).toContain("[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]");
    expect(off.stdout).toContain("latest requested artifact first");
    expect(off.stdout).toContain("Hide internal ids, command names");
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

  it("extracts apply_patch file headers and blocks missing work adoption", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-patch-paths-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-patch",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/protocol.ts",
            "@@",
            "-old",
            "+new",
            "*** End Patch"
          ].join("\n")
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      readonly decision?: string;
      readonly reason?: string;
    };
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("active work frame");
    expect(output.reason).toContain("Use the shared-work helper for the exact command");
    expect(output.reason).toContain("[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]");
    expect(output.reason).toContain("Internal shared-work maintenance");
    expect(output.reason).toContain("latest requested artifact first");
    expect(output.reason).toContain("Hide internal ids, command names");

    const store = await resolveWorkspaceStore(workspace, { env });
    const session = await readFile(
      store.layout.sessionPath(createAdapterSessionKey("codex", "S-patch")),
      "utf8"
    );
    const actorId = actorIdFromSession(session);
    const presence = await readFile(store.layout.actorPresencePath(actorId), "utf8");
    expect(presence).toContain("src/protocol.ts");
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]).toMatchObject({
      paths: ["src/protocol.ts"],
      toolMode: "mutating",
      nudge: true,
      nudgeKinds: ["work-adoption"],
      decision: "block"
    });
  });

  it("classifies nested multi-tool shell mutation as mutating work adoption", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-multi-tool-shell-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-multi-tool-shell",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "multi_tool_use.parallel",
        tool_input: {
          tool_uses: [
            {
              recipient_name: "functions.shell_command",
              parameters: {
                command: "Set-Content -Path src/protocol.ts -Value changed"
              }
            }
          ]
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      readonly decision?: string;
      readonly reason?: string;
    };
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("active work frame");

    const store = await resolveWorkspaceStore(workspace, { env });
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]).toMatchObject({
      paths: ["src/protocol.ts"],
      toolMode: "mutating",
      nudge: true,
      nudgeKinds: ["work-adoption"],
      decision: "block"
    });
  });

  it("requires initial context evidence when active work receives mutating activity", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-active-evidence-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);

    const start = await runHookHandler({
      adapter: "codex",
      event: "session-start",
      payload: {
        session_id: "S-active-evidence",
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
      workId: "AW-active-evidence",
      title: "Active evidence test",
      paths: ["src/protocol.ts"],
      now: "2026-05-18T00:00:01.000Z"
    });

    const zeroEvidence = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-active-evidence",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/protocol.ts",
            "@@",
            "-old",
            "+new",
            "*** End Patch"
          ].join("\n")
        }
      },
      env,
      now: "2026-05-18T00:00:02.000Z"
    });

    const zeroEvidenceOutput = JSON.parse(zeroEvidence.stdout) as {
      readonly hookSpecificOutput?: { readonly additionalContext?: string };
    };
    expect(zeroEvidenceOutput.hookSpecificOutput?.additionalContext).toContain("Record active-work context evidence");
    expect(zeroEvidenceOutput.hookSpecificOutput?.additionalContext).toContain("no context evidence yet");
    expect(zeroEvidenceOutput.hookSpecificOutput?.additionalContext).toContain("events recorded: 1");
    expect(zeroEvidenceOutput.hookSpecificOutput?.additionalContext).toContain("Evidence needs: frame, observed basis");
    expect(zeroEvidenceOutput.hookSpecificOutput?.additionalContext).not.toContain("no active work frame");

    await appendWorkEvidence(store, {
      actorId,
      evidence: ["Context: current frame; observed basis; touched src/protocol.ts; next pass check"],
      now: "2026-05-18T00:00:03.000Z"
    });
    const evidenced = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-active-evidence",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/protocol.ts",
            "@@",
            "-new",
            "+newer",
            "*** End Patch"
          ].join("\n")
        }
      },
      env,
      now: "2026-05-18T00:00:04.000Z"
    });
    const evidencedOutput = JSON.parse(evidenced.stdout) as {
      readonly hookSpecificOutput?: { readonly additionalContext?: string };
    };
    expect(evidencedOutput.hookSpecificOutput?.additionalContext).toContain("Active shared-work context");
    expect(evidencedOutput.hookSpecificOutput?.additionalContext).not.toContain("Record active-work context evidence");

    const repeated = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-active-evidence",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/protocol.ts",
            "@@",
            "-newer",
            "+newest",
            "*** End Patch"
          ].join("\n")
        }
      },
      env,
      now: "2026-05-18T00:00:05.000Z"
    });
    expect(JSON.parse(repeated.stdout)).toEqual({});
  });

  it("records read-only shell paths without ownership nudges", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-shell-paths-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "AgentQ/packages/cli/src"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-shell",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "rtk pwsh -NoProfile -Command \"Select-String -Path 'AgentQ/packages/cli/src/main.ts' -Pattern 'routeable'\""
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    const store = await resolveWorkspaceStore(workspace, { env });
    const session = await readFile(
      store.layout.sessionPath(createAdapterSessionKey("codex", "S-shell")),
      "utf8"
    );
    const actorId = actorIdFromSession(session);
    const presence = await readFile(store.layout.actorPresencePath(actorId), "utf8");
    expect(presence).toContain("AgentQ/packages/cli/src/main.ts");
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]).toMatchObject({
      paths: ["AgentQ/packages/cli/src/main.ts"],
      toolMode: "read-only",
      nudge: false
    });
    expect(events[0]?.nudgeKinds).toBeUndefined();
  });

  it("keeps PowerShell read-only diagnostics with assignments as read-only", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-pwsh-read-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "AgentQ/packages/core/src/hooks"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-pwsh-read",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "shell_command",
        tool_input: {
          command: "rtk pwsh -NoProfile -Command \"$p='AgentQ/packages/core/src/hooks/hookHandler.ts'; $lines=Get-Content -LiteralPath $p -Encoding UTF8; 389..410 | ForEach-Object { '{0}:{1}' -f $_, $lines[$_ - 1] }\""
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.stdout).toBe("{}\n");
    const store = await resolveWorkspaceStore(workspace, { env });
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]).toMatchObject({
      paths: ["AgentQ/packages/core/src/hooks/hookHandler.ts"],
      toolMode: "read-only",
      nudge: false
    });
    expect(events[0]?.nudgeKinds).toBeUndefined();
  });

  it("allows standalone AgentQ control commands to bootstrap active work", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-control-command-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "AgentQ/packages/cli/src"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-control-command",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "rtk agentq work start --actor codex@workspace@session --title Bootstrap --path AgentQ/packages/cli/src/main.ts"
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).not.toMatchObject({ decision: "block" });
    const store = await resolveWorkspaceStore(workspace, { env });
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]).toMatchObject({
      toolName: "Bash",
      toolMode: "read-only",
      ignoredCommands: [
        "rtk agentq work start --actor codex@workspace@session --title Bootstrap --path AgentQ/packages/cli/src/main.ts"
      ],
      nudge: false,
      decision: "allow"
    });
  });

  it("still blocks AgentQ control commands mixed with workspace mutation", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-control-command-mixed-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "AgentQ/packages/cli/src"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-control-command-mixed",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "rtk agentq work start --actor codex@workspace@session --title Bootstrap --path AgentQ/packages/cli/src/main.ts; Set-Content -Path AgentQ/packages/cli/src/main.ts -Value changed"
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      readonly decision?: string;
      readonly reason?: string;
    };
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("no active work frame");
  });

  it("allows the quality scorecard summary command as read-only when bytecode writes are disabled", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-scorecard-summary-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "docs/quality-experiments/scorecards"), { recursive: true });
    const env = testEnv(tempRoot);
    const command = "rtk python -B docs/quality-experiments/summarize_quality_scorecard.py --config docs/quality-experiments/scorecards/quality-scorecard-compact-full-vs-vanilla.json";

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-scorecard-summary",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).not.toMatchObject({ decision: "block" });
    const store = await resolveWorkspaceStore(workspace, { env });
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]).toMatchObject({
      toolName: "Bash",
      toolMode: "read-only",
      ignoredCommands: [],
      nudge: false,
      decision: "allow"
    });
  });

  it("does not treat scorecard scripts as read-only when bytecode writes are possible", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-scorecard-summary-unsafe-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "docs/quality-experiments/scorecards"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-scorecard-summary-unsafe",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "rtk python docs/quality-experiments/summarize_quality_scorecard.py --config docs/quality-experiments/scorecards/quality-scorecard-compact-full-vs-vanilla.json"
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      readonly decision?: string;
      readonly reason?: string;
    };
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("no active work frame");
  });

  it("normalizes punctuated file paths and rejects conceptual slash tokens", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-path-quality-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, ".github/instructions"), { recursive: true });
    await mkdir(path.join(workspace, ".codex/hooks"), { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-path-quality",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          file_path: ".github/instructions/agentq.instructions.md.",
          summary: "Compare success/fail and model/parser/writer outcomes",
          notes: "Keep plan/compiler/binder/executor and +option-enter/value-change/live as prose, not scope.",
          command: "rtk read .codex/hooks/session-note.py."
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.code).toBe(0);
    const store = await resolveWorkspaceStore(workspace, { env });
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]?.paths).toEqual(expect.arrayContaining([
      ".github/instructions/agentq.instructions.md",
      ".codex/hooks/session-note.py"
    ]));
    expect(new Set(events[0]?.paths).size).toBe(events[0]?.paths.length);
    expect(events[0]?.paths).not.toContain("success/fail");
    expect(events[0]?.paths).not.toContain("model/parser/writer");
    expect(events[0]?.paths).not.toContain("plan/compiler/binder/executor");
    expect(events[0]?.paths).not.toContain("+option-enter/value-change/live");
  });

  it("rejects HTML, glob, and command snippets as hook paths", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-noisy-paths-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const env = testEnv(tempRoot);

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-noisy",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          file_path: "><span>Ticks</span><b>${ticks.join(",
          paths: "rg -n pressure ProjectDD/**/*.cs",
          command: "rtk pwsh -NoProfile -Command \"Select-String -Path '*.cs' -Pattern '<span>'\""
        }
      },
      env,
      now: "2026-05-18T00:00:00.000Z"
    });

    expect(result.stdout).toBe("{}\n");
    const store = await resolveWorkspaceStore(workspace, { env });
    const session = await readFile(
      store.layout.sessionPath(createAdapterSessionKey("codex", "S-noisy")),
      "utf8"
    );
    const presence = await readFile(store.layout.actorPresencePath(actorIdFromSession(session)), "utf8");
    expect(presence).not.toContain("<span>");
    expect(presence).not.toContain("*.cs");
    expect(presence).not.toContain("rg -n");
    const events = await readDiagnosticEvents(store, 5);
    expect(events[0]).toMatchObject({
      paths: ["."],
      nudge: false
    });
  });

  it("bootstraps a missing session binding from Stop without blocking on scope-only weakness", async () => {
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
    expect(stop.stdout).toBe("{}\n");

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
      reason: expect.stringContaining("Active shared-work item remains open")
    });
    expect(JSON.parse(blocked.stdout).reason).toContain("[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]");
    expect(JSON.parse(blocked.stdout).reason).toContain("Do not use this maintenance status as the user-facing answer");
    expect(JSON.parse(blocked.stdout).reason).toContain("latest requested artifact first");

    // The open-work gate also blocks a stop attempt at most once; the retry
    // (stop_hook_active=true) passes while the work frame stays open.
    const blockedRetry = await runHookHandler({
      adapter: "codex",
      event: "stop",
      payload: {
        ...payload,
        hook_event_name: "Stop",
        tool_input: { file_path: "src/protocol.ts" },
        stop_hook_active: true
      },
      env,
      now: "2026-05-18T00:00:02.500Z"
    });
    expect(blockedRetry.stdout).toBe("{}\n");

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
    const actor = await createOrRefreshSessionBinding(store, {
      adapter: "codex",
      sessionId: "S7",
      cwd: workspace,
      activePaths: ["src/protocol.ts"],
      responsibilities: ["current protocol edit"],
      summary: "current protocol edit",
      now: "2026-05-18T00:00:00.000Z"
    });
    await startWork(store, {
      actorId: actor.actorId,
      workId: "AW-owner-overlap-current",
      title: "Current protocol edit",
      paths: ["src/protocol.ts"],
      now: "2026-05-18T00:00:00.000Z"
    });
    await appendWorkEvidence(store, {
      actorId: actor.actorId,
      evidence: ["Context exists so this test exercises owner overlap without work-adoption blocking."],
      now: "2026-05-18T00:00:00.500Z"
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
    expect(output.hookSpecificOutput?.additionalContext).toContain("related active owner");
    expect(output.hookSpecificOutput?.additionalContext).not.toContain(owner.actorId);
    expect(output.hookSpecificOutput?.additionalContext).toContain("ownership routes responsibility, not locks");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Preserve the user's requested artifact");
    expect(output.hookSpecificOutput?.additionalContext).toContain("continue unless this is a real conflict");
    expect(output.hookSpecificOutput?.additionalContext).toContain("ask a required question");
    expect(output.hookSpecificOutput?.additionalContext).toContain(`agentq owners --actor ${actor.actorId} --path src/protocol.ts`);
    expect(output.hookSpecificOutput?.additionalContext).toContain(`agentq question --actor ${actor.actorId} --to <owner-actor-id> --path src/protocol.ts`);
    expect(output.hookSpecificOutput?.additionalContext).toContain(`agentq note --actor ${actor.actorId} --to <owner-actor-id> --path src/protocol.ts`);
    expect(output.hookSpecificOutput?.additionalContext).toContain("[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Internal shared-work maintenance");
    expect(output.hookSpecificOutput?.additionalContext).toContain("latest requested artifact first");
    expect(output.hookSpecificOutput?.additionalContext.split("\n").length).toBeLessThanOrEqual(20);
  });

  it("adds a non-blocking owner nudge on exclusive resource overlap", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-resource-nudge-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "ProjectDD"), { recursive: true });
    const env = testEnv(tempRoot);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    const owner = await createOrRefreshSessionBinding(store, {
      adapter: "claude-code",
      sessionId: "owner",
      cwd: workspace,
      activePaths: ["ProjectDD"],
      activeResources: ["setup-watcher:ProjectDD/DDSetup"],
      responsibilities: ["DD setup watcher"],
      summary: "DD setup watcher",
      now: "2026-05-18T00:00:00.000Z"
    });
    const actor = await createOrRefreshSessionBinding(store, {
      adapter: "codex",
      sessionId: "S-resource",
      cwd: workspace,
      activePaths: ["ProjectDD"],
      activeResources: ["setup-watcher:ProjectDD/DDSetup"],
      responsibilities: ["current setup edit"],
      summary: "current setup edit",
      now: "2026-05-18T00:00:00.000Z"
    });
    await startWork(store, {
      actorId: actor.actorId,
      workId: "AW-resource-overlap-current",
      title: "Current setup edit",
      paths: ["ProjectDD"],
      now: "2026-05-18T00:00:00.000Z"
    });
    await appendWorkEvidence(store, {
      actorId: actor.actorId,
      evidence: ["Context exists so this test exercises resource overlap without work-adoption blocking."],
      now: "2026-05-18T00:00:00.500Z"
    });

    const result = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-resource",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: ".\\ProjectDD\\DDSetup.bat"
        }
      },
      env,
      now: "2026-05-18T00:00:01.000Z"
    });

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      readonly hookSpecificOutput?: { readonly additionalContext?: string };
    };
    expect(output.hookSpecificOutput?.additionalContext).not.toContain(owner.actorId);
    expect(output.hookSpecificOutput?.additionalContext).toContain("resource setup-watcher:ProjectDD/DDSetup");
    expect(output.hookSpecificOutput?.additionalContext).toContain(`agentq owners --actor ${actor.actorId} --resource setup-watcher:ProjectDD/DDSetup`);
    expect(output.hookSpecificOutput?.additionalContext).toContain(`agentq question --actor ${actor.actorId} --to <owner-actor-id> --resource setup-watcher:ProjectDD/DDSetup`);
    expect(output.hookSpecificOutput?.additionalContext).toContain(`agentq note --actor ${actor.actorId} --to <owner-actor-id> --resource setup-watcher:ProjectDD/DDSetup`);
  });

  it("does not infer resources from AgentQ meta commands and records diagnostics", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-meta-command-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const env = testEnv(tempRoot);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);

    await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-meta",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "agentq owners --resource unity:ProjectDD/DDUnity"
        }
      },
      env,
      now: "2026-05-18T00:00:01.000Z"
    });
    await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-meta",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "node AgentQ/packages/cli/dist/main.js owners --resource unity:ProjectDD/DDUnity"
        }
      },
      env,
      now: "2026-05-18T00:00:02.000Z"
    });
    const statusResult = await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-meta",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "rtk node AgentQ/packages/cli/dist/main.js status"
        }
      },
      env,
      now: "2026-05-18T00:00:03.000Z"
    });

    const actors = await listActorPresences(store);
    expect(actors).toHaveLength(1);
    expect(actors[0]?.activeResources).toBeUndefined();
    expect(statusResult.stdout).toBe("{}\n");
    const events = await readDiagnosticEvents(store, 5);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      event: "pre-tool",
      toolName: "Bash",
      resources: [],
      ignoredCommands: ["agentq owners --resource unity:ProjectDD/DDUnity"]
    });
    expect(events[1]).toMatchObject({
      event: "pre-tool",
      toolName: "Bash",
      resources: [],
      ignoredCommands: ["node AgentQ/packages/cli/dist/main.js owners --resource unity:ProjectDD/DDUnity"]
    });
    expect(events[2]).toMatchObject({
      event: "pre-tool",
      toolName: "Bash",
      toolMode: "read-only",
      resources: [],
      ignoredCommands: ["rtk node AgentQ/packages/cli/dist/main.js status"],
      nudge: false
    });
  });

  it("rejects shell and diff noise while preserving concrete hook paths", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-path-noise-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "Shared"), { recursive: true });
    const env = testEnv(tempRoot);

    await runHookHandler({
      adapter: "codex",
      event: "pre-tool",
      payload: {
        session_id: "S-path-noise",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "Set-Content -Path Shared/Good.md -Value ok; echo !docs/quality-experiments/IMPROVEMENT_REPORT.md +AGENTS.md Shared/.codegraph/codegraph.db).Length",
          paths: [
            "Shared/.gitignore\"",
            "!docs/quality-experiments/RESEARCH_NOTES_KO.md",
            "+AGENTS.md"
          ]
        }
      },
      env,
      now: "2026-05-18T00:00:01.000Z"
    });

    const store = await resolveWorkspaceStore(workspace, { env });
    const actors = await listActorPresences(store);
    expect(actors).toHaveLength(1);
    expect(actors[0]?.activePaths).toContain("Shared/Good.md");
    expect(actors[0]?.activePaths).toContain("Shared/.gitignore");
    expect(actors[0]?.activePaths).not.toContain("Shared/.gitignore\"");
    expect(actors[0]?.activePaths).not.toContain("Shared/.codegraph/codegraph.db).Length");
    expect(actors[0]?.activePaths.some((activePath) => activePath.startsWith("!"))).toBe(false);
    expect(actors[0]?.activePaths.some((activePath) => activePath.startsWith("+"))).toBe(false);
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

  it("refreshes a concrete actor heartbeat on pathless pre-tool without broadening scope", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-pre-tool-heartbeat-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    const env = testEnv(tempRoot);
    const store = await resolveWorkspaceStore(workspace, { env });
    await ensureWorkspaceStore(store);
    const binding = await createOrRefreshSessionBinding(store, {
      adapter: "codex",
      sessionId: "S-heartbeat",
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
        session_id: "S-heartbeat",
        cwd: workspace,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {
          command: "echo hello"
        }
      },
      env,
      now: "2026-05-18T00:10:00.000Z"
    });

    const presence = await readFile(store.layout.actorPresencePath(binding.actorId), "utf8");
    expect(presence).toContain("src/specific.ts");
    expect(presence).toContain("specific owner");
    expect(presence).toContain("2026-05-18T00:10:00.000Z");
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
  const match = stdout.match(/Shared-work id for edits\/handoffs only: ([^.]+)\./);
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
