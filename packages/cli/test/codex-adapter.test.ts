import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createQuestion,
  ensureWorkspaceStore,
  registerAdapterSession,
  resolveAdapterSessionActorId,
  resolveWorkspaceStore,
  setClaims,
  type WorkspaceStore
} from "@agentq/core";
import {
  extractCodexPatchTargets,
  runCodexHook,
  type ClientHookResult
} from "../src/adapters/codex.js";

describe("Codex adapter", () => {
  it("registers startup and resume from exact native identity with quiet output", async () => {
    const fixture = await createFixture("codex-session-");
    const startup = await runCodexHook(sessionStart(fixture, "startup"), fixture.options);
    expectQuiet(startup);

    const store = await openStore(fixture);
    const actorId = await resolveAdapterSessionActorId(store, {
      adapterId: "codex",
      nativeSessionId: "session-a",
      cwd: fixture.workspace
    });
    await expect(readFile(store.layout.actorClaimsPath(actorId), "utf8")).resolves.toContain(
      "paths: []"
    );

    const resume = await runCodexHook(sessionStart(fixture, "resume"), fixture.options);
    expectQuiet(resume);
    await expect(
      resolveAdapterSessionActorId(store, {
        adapterId: "codex",
        nativeSessionId: "session-a",
        cwd: fixture.workspace
      })
    ).resolves.toBe(actorId);
  });

  it("fails open with a diagnostic and no state when native identity is missing", async () => {
    const fixture = await createFixture("codex-missing-");
    const before = await treeSnapshot(fixture.stateRoot);

    const result = await runCodexHook(
      { ...sessionStart(fixture, "startup"), session_id: "" },
      fixture.options
    );

    expectQuiet(result);
    expect(result.diagnostics).toContainEqual({
      code: "registration_unavailable",
      reason: "missing_native_session"
    });
    expect(await treeSnapshot(fixture.stateRoot)).toEqual(before);
  });

  it("does not create a fallback actor when a later tool event has no binding", async () => {
    const fixture = await createFixture("codex-unbound-");
    const before = await treeSnapshot(fixture.stateRoot);

    const result = await runCodexHook(
      preToolUse(fixture, validPatch("src/file.ts")),
      fixture.options
    );

    expectQuiet(result);
    expect(result.diagnostics).toContainEqual({ code: "session_unregistered" });
    expect(await treeSnapshot(fixture.stateRoot)).toEqual(before);
  });

  it("extracts only complete apply_patch file headers including move targets", () => {
    const patchSource = [
      "*** Begin Patch",
      "*** Add File: src/add.ts",
      "+export {};",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/delete.ts",
      "*** End Patch"
    ].join("\r\n");

    expect(extractCodexPatchTargets(patchSource)).toEqual([
      "src/add.ts",
      "src/old.ts",
      "src/new.ts",
      "src/delete.ts"
    ]);
    expect(extractCodexPatchTargets(`${validPatch("src/final-lf.ts")}\n`)).toEqual([
      "src/final-lf.ts"
    ]);
    expect(
      extractCodexPatchTargets(
        "*** Begin Patch\n*** Add File: src/empty.ts\n*** End Patch"
      )
    ).toEqual([]);
    expect(extractCodexPatchTargets(`${validPatch("src/file.ts")}\ntrailing text`)).toEqual([]);
    expect(extractCodexPatchTargets("*** Begin Patch\n*** Update File: src/file.ts")).toEqual([]);
    expect(
      extractCodexPatchTargets(
        "*** Begin Patch\n*** Update File: src/file.ts\nshell text\n*** End Patch"
      )
    ).toEqual([]);
    expect(
      extractCodexPatchTargets(
        "*** Begin Patch\n*** Add File: src/real.ts\n+*** Update File: src/not-a-target.ts\n*** End Patch"
      )
    ).toEqual(["src/real.ts"]);
    expect(
      extractCodexPatchTargets(
        "*** Begin Patch\n*** Move to: src/new.ts\n*** End Patch"
      )
    ).toEqual([]);
  });

  it("keeps unsupported and malformed PreToolUse payloads byte-for-byte read-only", async () => {
    const fixture = await registeredFixture("codex-ignored-");
    const before = await treeSnapshot(fixture.stateRoot);
    const payloads = [
      { ...preToolUse(fixture, validPatch("src/file.ts")), tool_name: "Bash" },
      { ...preToolUse(fixture, validPatch("src/file.ts")), tool_name: "Edit" },
      { ...preToolUse(fixture, validPatch("src/file.ts")), tool_input: { command: 42 } },
      preToolUse(fixture, "*** Begin Patch\n*** Update File: src/file.ts")
    ];

    for (const payload of payloads) {
      expectQuiet(await runCodexHook(payload, fixture.options));
    }
    expect(await treeSnapshot(fixture.stateRoot)).toEqual(before);
  });

  it("emits only the exact brand-free overlap context and performs no writes", async () => {
    const fixture = await registeredFixture("codex-overlap-");
    const store = await openStore(fixture);
    const owner = await register(store, "vendor-one", "owner-session", fixture.now);
    await setClaims(store, owner, { paths: ["src/**"], resources: [], contracts: [] });
    const before = await treeSnapshot(fixture.stateRoot);

    const result = await runCodexHook(
      preToolUse(fixture, validPatch("src/file.ts")),
      fixture.options
    );

    expectContext(
      result,
      "PreToolUse",
      "Another active session has a declared claim overlapping this file."
    );
    expect(await treeSnapshot(fixture.stateRoot)).toEqual(before);
  });

  it("emits only the pending-question context and leaves question state untouched", async () => {
    const fixture = await registeredFixture("codex-question-");
    const store = await openStore(fixture);
    const recipient = await resolveAdapterSessionActorId(store, {
      adapterId: "codex",
      nativeSessionId: "session-a",
      cwd: fixture.workspace
    });
    await setClaims(store, recipient, { paths: ["src/**"], resources: [], contracts: [] });
    const sender = await register(store, "vendor-one", "sender-session", fixture.now);
    await createQuestion(store, {
      senderActorId: sender,
      recipientActorId: recipient,
      question: "Who owns this edit?",
      scope: { paths: ["src/file.ts"], resources: [], contracts: [] },
      now: fixture.now
    });
    const before = await treeSnapshot(fixture.stateRoot);

    const result = await runCodexHook(
      preToolUse(fixture, validPatch("other/file.ts")),
      fixture.options
    );

    expectContext(
      result,
      "PreToolUse",
      "A required coordination question is pending for this session: Who owns this edit?"
    );
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
    options: { env: { LOCALAPPDATA: stateRoot }, now: () => now }
  };
}

async function registeredFixture(prefix: string): Promise<Fixture> {
  const fixture = await createFixture(prefix);
  expectQuiet(await runCodexHook(sessionStart(fixture, "startup"), fixture.options));
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
    ["trans" + "cript_path"]: null,
    cwd: fixture.workspace,
    hook_event_name: "SessionStart",
    model: "gpt-test",
    permission_mode: "default",
    source
  };
}

function preToolUse(fixture: Fixture, command: unknown) {
  return {
    session_id: "session-a",
    turn_id: "turn-a",
    cwd: fixture.workspace,
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command },
    tool_use_id: "tool-a",
    model: "gpt-test",
    permission_mode: "default",
    ["trans" + "cript_path"]: null
  };
}

function validPatch(file: string): string {
  return `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch`;
}

function expectQuiet(result: ClientHookResult): void {
  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
}

function expectContext(
  result: ClientHookResult,
  hookEventName: "SessionStart" | "PreToolUse",
  additionalContext: string
): void {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    hookSpecificOutput: { hookEventName, additionalContext }
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
