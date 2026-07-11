import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceStore,
  registerAdapterSession,
  resolveAdapterSessionActorId,
  resolveWorkspaceStore,
  setClaims,
  type WorkspaceStore
} from "@agentq/core";
import {
  extractClaudeEditTarget,
  runClaudeHook,
  type ClientHookResult
} from "../src/adapters/claude.js";

describe("Claude adapter", () => {
  it("registers startup and resume from exact native identity with quiet output", async () => {
    const fixture = await createFixture("claude-session-");
    expectQuiet(await runClaudeHook(sessionStart(fixture, "startup"), fixture.options));
    const store = await openStore(fixture);
    const actorId = await resolveAdapterSessionActorId(store, {
      adapterId: "claude",
      nativeSessionId: "session-a",
      cwd: fixture.workspace
    });

    expectQuiet(await runClaudeHook(sessionStart(fixture, "resume"), fixture.options));
    await expect(
      resolveAdapterSessionActorId(store, {
        adapterId: "claude",
        nativeSessionId: "session-a",
        cwd: fixture.workspace
      })
    ).resolves.toBe(actorId);
  });

  it("fails open without state or fallback when identity or binding is missing", async () => {
    const fixture = await createFixture("claude-missing-");
    const before = await treeSnapshot(fixture.stateRoot);
    const missingIdentity = await runClaudeHook(
      { ...sessionStart(fixture, "startup"), session_id: undefined },
      fixture.options
    );
    expectQuiet(missingIdentity);
    expect(missingIdentity.diagnostics).toContainEqual({
      code: "registration_unavailable",
      reason: "missing_native_session"
    });

    const missingBinding = await runClaudeHook(
      preToolUse(fixture, "Edit", path.join(fixture.workspace, "src", "file.ts")),
      fixture.options
    );
    expectQuiet(missingBinding);
    expect(missingBinding.diagnostics).toContainEqual({ code: "session_unregistered" });
    expect(await treeSnapshot(fixture.stateRoot)).toEqual(before);
  });

  it("accepts only exact Edit or Write absolute file_path targets", async () => {
    const fixture = await createFixture("claude-target-");
    const absolute = path.join(fixture.workspace, "src", "file.ts");

    expect(extractClaudeEditTarget(preToolUse(fixture, "Edit", absolute))).toBe(absolute);
    expect(extractClaudeEditTarget(preToolUse(fixture, "Write", absolute))).toBe(absolute);
    expect(extractClaudeEditTarget(preToolUse(fixture, "MultiEdit", absolute))).toBeNull();
    expect(extractClaudeEditTarget(preToolUse(fixture, "Bash", absolute))).toBeNull();
    expect(extractClaudeEditTarget(preToolUse(fixture, "edit", absolute))).toBeNull();
    expect(extractClaudeEditTarget(preToolUse(fixture, "Edit", "src/file.ts"))).toBeNull();
    expect(
      extractClaudeEditTarget({
        ...preToolUse(fixture, "Edit", absolute),
        tool_input: { path: absolute }
      })
    ).toBeNull();
  });

  it("emits exact overlap context and keeps PreToolUse byte-for-byte read-only", async () => {
    const fixture = await registeredFixture("claude-overlap-");
    const store = await openStore(fixture);
    const owner = await register(store, "vendor-one", "owner-session", fixture.now);
    await setClaims(store, owner, { paths: ["src/**"], resources: [], contracts: [] });
    const before = await treeSnapshot(fixture.stateRoot);
    const target = path.join(fixture.workspace, "src", "file.ts");

    const result = await runClaudeHook(preToolUse(fixture, "Edit", target), fixture.options);

    expectContext(
      result,
      "Another active session has a declared claim overlapping this file."
    );
    expect(await treeSnapshot(fixture.stateRoot)).toEqual(before);
  });

  it("resolves absolute edit targets through the session workspace alias", async () => {
    const fixture = await registeredAliasedFixture("claude-alias-");
    const store = await openStore(fixture);
    const owner = await register(store, "vendor-one", "owner-session", fixture.now);
    await setClaims(store, owner, { paths: ["src/**"], resources: [], contracts: [] });
    const target = path.join(fixture.workspace, "src", "file.ts");

    const result = await runClaudeHook(preToolUse(fixture, "Edit", target), fixture.options);

    expectContext(
      result,
      "Another active session has a declared claim overlapping this file."
    );
  });

  it("returns byte-empty success for no overlap and unsupported tools", async () => {
    const fixture = await registeredFixture("claude-quiet-");
    const before = await treeSnapshot(fixture.stateRoot);
    const target = path.join(fixture.workspace, "src", "file.ts");

    expectQuiet(await runClaudeHook(preToolUse(fixture, "Write", target), fixture.options));
    expectQuiet(await runClaudeHook(preToolUse(fixture, "Read", target), fixture.options));
    expect(await treeSnapshot(fixture.stateRoot)).toEqual(before);
  });
});

interface Fixture {
  readonly workspace: string;
  readonly stateRoot: string;
  readonly now: string;
  readonly options: {
    readonly env: NodeJS.ProcessEnv;
    readonly now: () => string;
  };
}

async function createFixture(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace-a");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  const now = new Date().toISOString();
  return {
    workspace,
    stateRoot,
    now,
    options: {
      env: { LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot, HOME: stateRoot },
      now: () => now
    }
  };
}

async function registeredFixture(prefix: string): Promise<Fixture> {
  const fixture = await createFixture(prefix);
  expectQuiet(await runClaudeHook(sessionStart(fixture, "startup"), fixture.options));
  return fixture;
}

async function registeredAliasedFixture(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const realWorkspace = path.join(root, "workspace-real");
  const workspace = path.join(root, "workspace-alias");
  const stateRoot = path.join(root, "state");
  await mkdir(realWorkspace, { recursive: true });
  await symlink(realWorkspace, workspace, process.platform === "win32" ? "junction" : "dir");
  const now = new Date().toISOString();
  const fixture: Fixture = {
    workspace,
    stateRoot,
    now,
    options: {
      env: { LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot, HOME: stateRoot },
      now: () => now
    }
  };
  expectQuiet(await runClaudeHook(sessionStart(fixture, "startup"), fixture.options));
  return fixture;
}

async function openStore(fixture: Fixture): Promise<WorkspaceStore> {
  const store = await resolveWorkspaceStore(fixture.workspace, { env: fixture.options.env });
  await ensureWorkspaceStore(store);
  return store;
}

async function register(
  store: WorkspaceStore,
  adapterId: string,
  nativeSessionId: string,
  now: string
): Promise<string> {
  const result = await registerAdapterSession(store, {
    adapterId,
    nativeSessionId,
    cwd: store.workspaceRoot,
    now
  });
  if (result.status !== "registered") {
    throw new Error(`registration unavailable: ${result.reason}`);
  }
  return result.actorId;
}

function sessionStart(fixture: Fixture, source: "startup" | "resume") {
  return {
    session_id: "session-a",
    ["trans" + "cript_path"]: path.join(fixture.workspace, "trans" + "cript.jsonl"),
    cwd: fixture.workspace,
    hook_event_name: "SessionStart",
    source,
    model: "claude-test"
  };
}

function preToolUse(fixture: Fixture, toolName: string, filePath: unknown) {
  return {
    session_id: "session-a",
    ["trans" + "cript_path"]: path.join(fixture.workspace, "trans" + "cript.jsonl"),
    cwd: fixture.workspace,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_use_id: "tool-a"
  };
}

function expectQuiet(result: ClientHookResult): void {
  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
}

function expectContext(result: ClientHookResult, additionalContext: string): void {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext }
  });
  expect(result.stdout).not.toMatch(/AgentQ|actor_|systemMessage|suppressOutput|permissionDecision|updatedInput/);
}

async function treeSnapshot(root: string): Promise<readonly string[]> {
  const files = await listFiles(root, "");
  return await Promise.all(
    files.sort().map(async (relative) => {
      const bytes = await readFile(path.join(root, relative));
      return `${relative.replace(/\\/g, "/")}\0${createHash("sha256").update(bytes).digest("hex")}`;
    })
  );
}

async function listFiles(root: string, relative: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
