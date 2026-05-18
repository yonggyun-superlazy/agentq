import path from "node:path";
import {
  createOrRefreshSessionBinding,
  resolveHookActorId,
  type HookActorLookup
} from "../store/sessionBinding.js";
import { ensureWorkspaceStore, resolveWorkspaceStore, type WorkspaceStore } from "../store/workspaceStore.js";
import { planStopContinuation, runDoneCheck } from "../state/doneCheck.js";
import type { AgentKind } from "../domain/types.js";
import {
  appendActiveWorkTouch,
  planWorkStopContinuation,
  readActiveWorkState,
  runWorkDoneCheck
} from "../work/workStack.js";

export type HookAdapter = "codex" | "claude-code" | "copilot-cli";
export type HookRuntimeEvent = "session-start" | "pre-tool" | "stop";

export interface HookHandlerOptions {
  readonly adapter: HookAdapter;
  readonly event: HookRuntimeEvent;
  readonly payload: unknown;
  readonly env?: NodeJS.ProcessEnv;
  readonly now: string;
}

export interface HookHandlerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type PayloadObject = { readonly [key: string]: unknown };

export async function runHookHandler(options: HookHandlerOptions): Promise<HookHandlerResult> {
  const payload = asPayloadObject(options.payload);
  const cwd = stringField(payload, "cwd");
  const sessionId = sessionIdFromPayload(payload);
  const store = await openHookStore(cwd, options.env);

  if (options.event === "session-start") {
    const binding = await createOrRefreshSessionBinding(store, {
      adapter: adapterKind(options.adapter),
      sessionId,
      cwd,
      activePaths: ["."],
      responsibilities: [`${options.adapter} session`],
      summary: `${options.adapter} hook session`,
      now: options.now
    });

    return {
      code: 0,
      stdout: `${JSON.stringify(sessionStartOutput(options.adapter, binding.actorId))}\n`,
      stderr: ""
    };
  }

  if (options.event === "pre-tool") {
    const hookPaths = extractActivePaths(payload, cwd);
    const adapter = adapterKind(options.adapter);
    const actorId = await resolveOrCreateHookActorId(store, {
      adapter,
      sessionId,
      cwd
    }, {
      activePaths: hookPaths,
      responsibilities: [`${options.adapter} active tool scope`],
      summary: `${options.adapter} pre-tool scope`,
      now: options.now
    });
    await appendSpecificActiveWorkTouch(store, actorId, hookPaths, options.now);
    await refreshHookPresence(store, {
      adapter,
      sessionId,
      cwd,
      actorId,
      hookPaths,
      fallbackResponsibilities: [`${options.adapter} active tool scope`],
      fallbackSummary: `${options.adapter} pre-tool scope`,
      now: options.now
    });

    return {
      code: 0,
      stdout: `${JSON.stringify(preToolOutput(options.adapter, actorId))}\n`,
      stderr: ""
    };
  }

  const adapter = adapterKind(options.adapter);
  const actorId = await resolveOrCreateHookActorId(store, {
    adapter,
    sessionId,
    cwd
  }, {
    activePaths: extractActivePaths(payload, cwd),
    responsibilities: [`${options.adapter} stop gate`],
    summary: `${options.adapter} stop gate`,
    now: options.now
  });
  const stopPaths = extractActivePaths(payload, cwd);
  await appendSpecificActiveWorkTouch(store, actorId, stopPaths, options.now);
  await refreshHookPresence(store, {
    adapter,
    sessionId,
    cwd,
    actorId,
    hookPaths: stopPaths,
    fallbackResponsibilities: [`${options.adapter} stop gate`],
    fallbackSummary: `${options.adapter} stop gate`,
    now: options.now
  });

  const done = await runDoneCheck(store, actorId);
  const decision = planStopContinuation(done, booleanField(payload, "stop_hook_active"));
  if (!done.ok) {
    return {
      code: 0,
      stdout: `${JSON.stringify(blockOutput(options.adapter, decision.reason))}\n`,
      stderr: ""
    };
  }

  const workDone = await runWorkDoneCheck(store, actorId);
  if (!workDone.ok) {
    return {
      code: 0,
      stdout: `${JSON.stringify(blockOutput(options.adapter, planWorkStopContinuation(workDone)))}\n`,
      stderr: ""
    };
  }

  return {
    code: 0,
    stdout: "{}\n",
    stderr: ""
  };
}

async function appendSpecificActiveWorkTouch(
  store: WorkspaceStore,
  actorId: string,
  paths: readonly string[],
  now: string
): Promise<void> {
  const specificPaths = paths.filter(isSpecificPath);
  if (specificPaths.length === 0) {
    return;
  }

  await appendActiveWorkTouch(store, {
    actorId,
    paths: specificPaths,
    now
  });
}

async function refreshHookPresence(
  store: WorkspaceStore,
  input: {
    readonly adapter: AgentKind;
    readonly sessionId: string;
    readonly cwd: string;
    readonly actorId: string;
    readonly hookPaths: readonly string[];
    readonly fallbackResponsibilities: readonly string[];
    readonly fallbackSummary: string;
    readonly now: string;
  }
): Promise<void> {
  const activeWork = await readActiveWorkState(store, input.actorId);
  if (activeWork === null && !input.hookPaths.some(isSpecificPath)) {
    return;
  }

  const activePaths = effectivePresencePaths(input.hookPaths, activeWork?.touchedPaths ?? []);
  const summary = activeWork?.title ?? input.fallbackSummary;
  const responsibilities = activeWork === null ? input.fallbackResponsibilities : [activeWork.title];

  await createOrRefreshSessionBinding(store, {
    adapter: input.adapter,
    sessionId: input.sessionId,
    cwd: input.cwd,
    activePaths,
    responsibilities,
    summary,
    now: input.now
  });
}

function effectivePresencePaths(
  hookPaths: readonly string[],
  workPaths: readonly string[]
): string[] {
  const specific = [...hookPaths, ...workPaths].filter(isSpecificPath);
  return uniquePaths(specific.length > 0 ? specific : hookPaths).slice(0, 8);
}

function uniquePaths(paths: readonly string[]): string[] {
  const unique = new Set(paths);
  return unique.size === 0 ? ["."] : [...unique];
}

function isSpecificPath(pathValue: string): boolean {
  return normalizePresencePath(pathValue) !== ".";
}

function normalizePresencePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

async function resolveOrCreateHookActorId(
  store: WorkspaceStore,
  lookup: HookActorLookup,
  bootstrap: {
    readonly activePaths: readonly string[];
    readonly responsibilities: readonly string[];
    readonly summary: string;
    readonly now: string;
  }
): Promise<string> {
  try {
    return await resolveHookActorId(store, lookup);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    const binding = await createOrRefreshSessionBinding(store, {
      adapter: lookup.adapter,
      sessionId: lookup.sessionId,
      cwd: lookup.cwd,
      activePaths: bootstrap.activePaths,
      responsibilities: bootstrap.responsibilities,
      summary: bootstrap.summary,
      now: bootstrap.now
    });
    return binding.actorId;
  }
}

async function openHookStore(cwd: string, env: NodeJS.ProcessEnv | undefined): Promise<WorkspaceStore> {
  const store = await resolveWorkspaceStore(cwd, env === undefined ? {} : { env });
  await ensureWorkspaceStore(store);
  return store;
}

function sessionStartOutput(adapter: HookAdapter, actorId: string): object {
  const context = `AgentQ actor id: ${actorId}. Use this exact id in every AgentQ command: agentq inbox --actor ${actorId}, agentq work status --actor ${actorId}, and agentq done-check --actor ${actorId}.`;

  if (adapter === "copilot-cli") {
    return { additionalContext: context };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context
    }
  };
}

function preToolOutput(adapter: HookAdapter, actorId: string): object {
  if (adapter === "copilot-cli") {
    return { additionalContext: `AgentQ refreshed active scope for ${actorId}.` };
  }

  return {};
}

function blockOutput(adapter: HookAdapter, reason: string): object {
  if (adapter === "copilot-cli") {
    return {
      decision: "block",
      reason
    };
  }

  return {
    decision: "block",
    reason
  };
}

function adapterKind(adapter: HookAdapter): AgentKind {
  return adapter;
}

function asPayloadObject(payload: unknown): PayloadObject {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("AgentQ hook payload must be a JSON object.");
  }

  return payload as PayloadObject;
}

function sessionIdFromPayload(payload: PayloadObject): string {
  const sessionId = stringFieldOptional(payload, "session_id") ?? stringFieldOptional(payload, "sessionId");
  if (sessionId === undefined) {
    throw new Error("AgentQ hook payload is missing session_id/sessionId.");
  }

  return sessionId;
}

function stringField(payload: PayloadObject, key: string): string {
  const value = stringFieldOptional(payload, key);
  if (value === undefined) {
    throw new Error(`AgentQ hook payload is missing ${key}.`);
  }

  return value;
}

function stringFieldOptional(payload: PayloadObject, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}

function booleanField(payload: PayloadObject, key: string): boolean {
  return payload[key] === true;
}

function extractActivePaths(payload: PayloadObject, cwd: string): string[] {
  const candidates = new Set<string>();
  collectPathCandidates(payload, candidates);

  const paths = [...candidates]
    .map((candidate) => normalizePathCandidate(candidate, cwd))
    .filter((candidate): candidate is string => candidate !== null)
    .slice(0, 8);

  return paths.length === 0 ? ["."] : paths;
}

function collectPathCandidates(value: unknown, candidates: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (isPathLikeKey(key) || isPathLikeValue(value)) {
      candidates.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidates(item, candidates, key);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "cwd" || childKey === "transcript_path") {
      continue;
    }

    collectPathCandidates(childValue, candidates, childKey);
  }
}

function isPathLikeKey(key: string): boolean {
  return /(^|_)(file|files|path|paths|relative_path|file_path|filepath)$/i.test(key);
}

function isPathLikeValue(value: string): boolean {
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) {
    return false;
  }

  return trimmed.includes("/") || trimmed.includes("\\");
}

function normalizePathCandidate(value: string, cwd: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 260) {
    return null;
  }

  const resolved = path.resolve(cwd, trimmed);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return relative.length === 0 ? "." : relative.replace(/\\/g, "/");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
