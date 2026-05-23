import path from "node:path";
import {
  createOrRefreshSessionBinding,
  readActorPresence,
  refreshActorPresence,
  resolveHookActorId,
  type HookActorLookup
} from "../store/sessionBinding.js";
import { ensureWorkspaceStore, resolveWorkspaceStore, type WorkspaceStore } from "../store/workspaceStore.js";
import { planStopContinuation, runDoneCheck } from "../state/doneCheck.js";
import {
  findActivePathOwners,
  findActiveResourceOwners,
  type ActivePathOwnerMatch,
  type ActiveResourceOwnerMatch
} from "../routing/routeBlocker.js";
import type { AgentKind } from "../domain/types.js";
import {
  appendActiveWorkTouch,
  planWorkStopContinuation,
  readActiveWorkState,
  runWorkDoneCheck
} from "../work/workStack.js";
import { tryAppendDiagnosticEvent } from "../diagnostics/ringLog.js";

export type HookAdapter = "codex" | "claude-code" | "copilot-cli";
export type HookRuntimeEvent = "session-start" | "pre-tool" | "stop";

const UNITY_EXECUTABLE_PATTERN = /(^|[\/\s"';&|])unity(?:\.exe)?(?=$|[\s"';&|])/i;

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
    const resourceInference = extractActiveResourceInference(payload, cwd);
    const hookResources = resourceInference.resources;
    const mutatingTool = shouldNudgeForTool(payload);
    const adapter = adapterKind(options.adapter);
    const actorId = await resolveOrCreateHookActorId(store, {
      adapter,
      sessionId,
      cwd
    }, {
      activePaths: mutatingTool ? hookPaths : ["."],
      observedPaths: mutatingTool ? [] : hookPaths.filter(isSpecificPath),
      activeResources: mutatingTool ? hookResources : [],
      responsibilities: [mutatingTool ? `${options.adapter} active tool scope` : `${options.adapter} read scope`],
      summary: mutatingTool ? `${options.adapter} pre-tool scope` : `${options.adapter} read scope`,
      now: options.now
    });
    await appendSpecificActiveWorkTouch(store, actorId, hookPaths, options.now);
    await refreshHookPresence(store, {
      adapter,
      sessionId,
      cwd,
      actorId,
      hookPaths,
      hookResources,
      mutatingTool,
      fallbackResponsibilities: [`${options.adapter} active tool scope`],
      fallbackSummary: `${options.adapter} pre-tool scope`,
      now: options.now
    });
    const ownerNudge = mutatingTool
      ? await buildRelatedOwnerNudge(store, actorId, hookPaths, hookResources, options.now)
      : null;
    await writeHookDiagnostic(store, {
      actorId,
      adapter: options.adapter,
      event: options.event,
      sessionId,
      toolName: toolNameFromPayload(payload),
      paths: hookPaths,
      resources: hookResources,
      ignoredCommands: resourceInference.ignoredCommands,
      nudge: ownerNudge !== null,
      at: options.now
    });

    return {
      code: 0,
      stdout: `${JSON.stringify(preToolOutput(options.adapter, actorId, ownerNudge))}\n`,
      stderr: ""
    };
  }

  const adapter = adapterKind(options.adapter);
  const stopResourceInference = extractActiveResourceInference(payload, cwd);
  const actorId = await resolveOrCreateHookActorId(store, {
    adapter,
    sessionId,
    cwd
  }, {
    activePaths: extractActivePaths(payload, cwd),
    observedPaths: [],
    activeResources: stopResourceInference.resources,
    responsibilities: [`${options.adapter} stop gate`],
    summary: `${options.adapter} stop gate`,
    now: options.now
  });
  const stopPaths = extractActivePaths(payload, cwd);
  const stopResources = stopResourceInference.resources;
  await appendSpecificActiveWorkTouch(store, actorId, stopPaths, options.now);
  await refreshHookPresence(store, {
    adapter,
    sessionId,
    cwd,
    actorId,
    hookPaths: stopPaths,
    hookResources: stopResources,
    mutatingTool: true,
    fallbackResponsibilities: [`${options.adapter} stop gate`],
    fallbackSummary: `${options.adapter} stop gate`,
    now: options.now
  });
  await writeHookDiagnostic(store, {
    actorId,
    adapter: options.adapter,
    event: options.event,
    sessionId,
    paths: stopPaths,
    resources: stopResources,
    ignoredCommands: stopResourceInference.ignoredCommands,
    at: options.now
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
    readonly hookResources: readonly string[];
    readonly mutatingTool: boolean;
    readonly fallbackResponsibilities: readonly string[];
    readonly fallbackSummary: string;
    readonly now: string;
  }
): Promise<void> {
  const activeWork = await readActiveWorkState(store, input.actorId);
  if (activeWork === null && !input.hookPaths.some(isSpecificPath) && input.hookResources.length === 0) {
    const existing = await readActorPresence(store, input.actorId);
    if (existing.activePaths.some(isSpecificPath) || (existing.activeResources ?? []).length > 0) {
      await refreshActorPresence(store, {
        actorId: input.actorId,
        cwd: input.cwd,
        activePaths: [],
        responsibilities: [],
        now: input.now
      });
    }
    return;
  }

  const activePaths = effectivePresencePaths(input.hookPaths, activeWork?.touchedPaths ?? []);
  if (activeWork === null) {
    if (!input.mutatingTool) {
      await refreshActorPresence(store, {
        actorId: input.actorId,
        cwd: input.cwd,
        activePaths: [],
        observedPaths: activePaths.filter(isSpecificPath),
        responsibilities: [],
        mergeObservedPaths: true,
        now: input.now
      });
      return;
    }

    await refreshActorPresence(store, {
      actorId: input.actorId,
      cwd: input.cwd,
      activePaths,
      activeResources: input.hookResources,
      responsibilities: [],
      mergeActivePaths: true,
      now: input.now
    });
    return;
  }

  await refreshActorPresence(store, {
    actorId: input.actorId,
    cwd: input.cwd,
    activePaths,
    ...(input.hookResources.length === 0 ? {} : { activeResources: input.hookResources, mergeActiveResources: true }),
    responsibilities: [activeWork.title],
    summary: activeWork.title,
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
    readonly observedPaths: readonly string[];
    readonly activeResources: readonly string[];
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
      observedPaths: bootstrap.observedPaths,
      activeResources: bootstrap.activeResources,
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
  const context = `Internal shared-work id: ${actorId}. For file/code edits, handoffs, active work, or unclear shared-work state, run: agentq next --actor ${actorId}. For short read-only answers, do not run shared-work commands before answering. Keep internal command names and identifiers out of user-facing answers.`;

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

function preToolOutput(adapter: HookAdapter, actorId: string, nudge: string | null): object {
  if (adapter === "copilot-cli") {
    return {
      additionalContext: nudge ?? `AgentQ refreshed active scope for ${actorId}.`
    };
  }

  if (nudge !== null) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: nudge
      }
    };
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

function toolNameFromPayload(payload: PayloadObject): string | undefined {
  return stringFieldOptional(payload, "tool_name") ?? stringFieldOptional(payload, "toolName");
}

function shouldNudgeForTool(payload: PayloadObject): boolean {
  const toolName = toolNameFromPayload(payload) ?? "";
  return /(bash|write|edit|apply|patch|shell|command|delete|move|rename)/i.test(toolName);
}

async function writeHookDiagnostic(
  store: WorkspaceStore,
  input: {
    readonly actorId: string;
    readonly adapter: HookAdapter;
    readonly event: HookRuntimeEvent;
    readonly sessionId: string;
    readonly toolName?: string | undefined;
    readonly paths: readonly string[];
    readonly resources: readonly string[];
    readonly ignoredCommands: readonly string[];
    readonly nudge?: boolean;
    readonly at: string;
  }
): Promise<void> {
  await tryAppendDiagnosticEvent(store, {
    kind: "hook",
    actorId: input.actorId,
    adapter: input.adapter,
    event: input.event,
    sessionId: input.sessionId,
    ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
    paths: [...input.paths],
    resources: [...input.resources],
    ignoredCommands: [...input.ignoredCommands],
    ...(input.nudge === undefined ? {} : { nudge: input.nudge }),
    at: input.at
  });
}

async function buildRelatedOwnerNudge(
  store: WorkspaceStore,
  actorId: string,
  paths: readonly string[],
  resources: readonly string[],
  now: string
): Promise<string | null> {
  const pathMatches = await findActivePathOwners(store, {
    actorId,
    paths,
    now,
    staleAfterMs: 3_600_000
  });
  const resourceMatches = await findActiveResourceOwners(store, {
    actorId,
    resources,
    now,
    staleAfterMs: 3_600_000
  });
  if (pathMatches.length === 0 && resourceMatches.length === 0) {
    return null;
  }

  return renderRelatedOwnerNudge(actorId, pathMatches.slice(0, 3), resourceMatches.slice(0, 3));
}

function renderRelatedOwnerNudge(
  actorId: string,
  pathMatches: readonly ActivePathOwnerMatch[],
  resourceMatches: readonly ActiveResourceOwnerMatch[]
): string {
  const firstResource = resourceMatches[0]?.queriedResource;
  const firstPath = pathMatches[0]?.queriedPath;
  const firstTargetActorId = resourceMatches[0]?.actor.actorId ?? pathMatches[0]?.actor.actorId ?? "<target-actor-id>";
  const routeArg = firstResource !== undefined
    ? `--resource ${firstResource}`
    : `--path ${firstPath ?? "<path>"}`;
  return [
    "AgentQ related active actor detected for this tool path or resource.",
    ...pathMatches.map(
      (match) =>
        `- ${match.actor.actorId} owns ${match.activePath}; responsibility: ${match.actor.responsibilities.join(", ")}`
    ),
    ...resourceMatches.map(
      (match) =>
        `- ${match.actor.actorId} uses ${match.activeResource}; responsibility: ${match.actor.responsibilities.join(", ")}`
    ),
    "Ownership is a routing signal, not a lock. Ask the owner to classify overlap; do not wait silently from presence alone.",
    "If this changes their contract or unblocks their work, ask before local-only resolution:",
    `agentq question --actor ${actorId} --to ${firstTargetActorId} ${routeArg} --question "<decision needed>" --expect "<answer with evidence>"`
  ].join("\n");
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

interface ResourceInference {
  readonly resources: readonly string[];
  readonly ignoredCommands: readonly string[];
}

function extractActiveResourceInference(payload: PayloadObject, cwd: string): ResourceInference {
  const commands = new Set<string>();
  collectCommandCandidates(payload, commands);
  const resources = new Set<string>();
  const ignoredCommands = new Set<string>();

  for (const command of commands) {
    if (isAgentQMetaCommand(command)) {
      ignoredCommands.add(summarizeCommand(command));
      continue;
    }

    for (const resource of inferCommandResources(command, cwd)) {
      resources.add(resource);
    }
  }

  return {
    resources: [...resources].slice(0, 8),
    ignoredCommands: [...ignoredCommands].slice(0, 8)
  };
}

function collectCommandCandidates(value: unknown, commands: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (/^(command|cmd|script|shell_command)$/i.test(key)) {
      commands.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCommandCandidates(item, commands, key);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    collectCommandCandidates(childValue, commands, childKey);
  }
}

function inferCommandResources(command: string, cwd: string): string[] {
  const normalizedCommand = command.replace(/\\/g, "/");
  const lower = normalizedCommand.toLowerCase();
  const resources = new Set<string>();

  if (lower.includes("projectdd/ddsetup.bat") || /\bddsetup\.bat\b/i.test(normalizedCommand)) {
    resources.add("setup-watcher:ProjectDD/DDSetup");
  }
  if (lower.includes("projectshe/shesetup.bat") || /\bshesetup\.bat\b/i.test(normalizedCommand)) {
    resources.add("setup-watcher:ProjectSHE/SHESetup");
  }
  if (lower.includes("projectdd/ddweaver")) {
    resources.add("codegen:ProjectDD/DDWeaver");
  }

  const unityProjectPath = extractUnityProjectPath(normalizedCommand, cwd);
  if (unityProjectPath !== null) {
    resources.add(`unity:${unityProjectPath}`);
  } else if (UNITY_EXECUTABLE_PATTERN.test(normalizedCommand)) {
    for (const projectPath of [
      "ProjectDD/DDUnity",
      "ProjectSHE",
      "Shared/Superlazy.Unity.TestHost",
      "ProjectDD/DDUnityTestHost"
    ]) {
      if (lower.includes(projectPath.toLowerCase())) {
        resources.add(`unity:${projectPath}`);
      }
    }
  }

  return [...resources];
}

function isAgentQMetaCommand(command: string): boolean {
  const normalizedCommand = command.replace(/\\/g, "/");
  const subcommands = "accept-blocked|actors|block|diag|doctor|done-check|enter|follow-up|hook|inbox|install|note|owners|question|respond|scope-check|status|supersede|uninstall|wake|work";
  return new RegExp(`(^|[\\s"';&|])agentq(?:\\.cmd|\\.ps1|\\.bat|\\.exe)?\\s+(${subcommands})\\b`, "i").test(normalizedCommand) ||
    new RegExp(`(^|[\\s"';&|])(?:node(?:\\.exe)?|tsx(?:\\.cmd|\\.ps1|\\.bat|\\.exe)?)\\s+[^\\s"';&|]*agentq[^\\s"';&|]*/packages/cli/(?:dist/main\\.js|src/main\\.ts)\\s+(${subcommands})\\b`, "i").test(normalizedCommand);
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function extractUnityProjectPath(command: string, cwd: string): string | null {
  if (!UNITY_EXECUTABLE_PATTERN.test(command)) {
    return null;
  }

  const match = /-projectPath\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(command);
  const rawPath = match?.[1] ?? match?.[2] ?? match?.[3];
  if (rawPath === undefined) {
    return null;
  }

  return normalizePathCandidate(rawPath, cwd);
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
