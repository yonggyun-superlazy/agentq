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
import { actorScopeWeaknesses } from "../state/scopeCheck.js";
import { renderInternalQueueMaintenance } from "../output/internalEnvelope.js";

export type HookAdapter = "codex" | "claude-code" | "copilot-cli";
export type HookRuntimeEvent = "session-start" | "pre-tool" | "stop";

const UNITY_EXECUTABLE_PATTERN = /(^|[\/\s"';&|])unity(?:\.exe)?(?=$|[\s"';&|])/i;
const PATH_FILE_EXTENSION_PATTERN = /\.(?:asmdef|asset|bat|cs|csproj|html|js|json|log|md|prefab|prompt\.txt|ps1|py|result\.txt|sln|slui|stamp|ts|tsx|txt|xml|yaml|yml)$/i;
const TRUSTED_WORKSPACE_PATH_ROOTS = new Set([
  ".claude",
  ".codex",
  ".github",
  ".tmp",
  "agentq",
  "docs",
  "projectdd",
  "projectim",
  "projectshe",
  "shared",
  "tools",
  "wiki"
]);

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
      stdout: `${JSON.stringify(sessionStartOutput(options.adapter, binding.actorId, options.env))}\n`,
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
    const preToolNudge = mutatingTool
      ? await buildPreToolNudge(store, actorId, hookPaths, hookResources, options.now)
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
      nudge: preToolNudge !== null,
      nudgeKinds: preToolNudge?.kinds ?? [],
      at: options.now
    });

    return {
      code: 0,
      stdout: `${JSON.stringify(preToolOutput(options.adapter, actorId, preToolNudge?.message ?? null))}\n`,
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

function sessionStartOutput(adapter: HookAdapter, actorId: string, env: NodeJS.ProcessEnv | undefined): object {
  const mode = (env?.AGENTQ_SESSION_START_CONTEXT ?? "compact").toLowerCase();
  const body =
    mode === "off" || mode === "none" || mode === "0"
      ? [
        "Shared-work note: short read-only answers can answer directly.",
        "Use shared-work commands only for edits, handoffs, active work, or unclear shared state."
      ]
      : mode === "full"
        ? [
          `Internal shared-work id: ${actorId}.`,
          `For file/code edits, handoffs, active work, or unclear shared-work state, run: agentq next --actor ${actorId}.`,
          "For short read-only answers, do not run shared-work commands before answering."
        ]
        : [
          `Shared-work id for edits/handoffs only: ${actorId}.`,
          `Run agentq next --actor ${actorId} before edits, handoffs, active work, or unclear shared state.`,
          "Short read-only answers can answer directly."
        ];
  const context = renderInternalQueueMaintenance({
    summary: "AgentQ session shared-work context.",
    afterAction: "After handling shared-work maintenance, resume the user's original request and answer the requested artifact first.",
    body
  });

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
    readonly nudgeKinds?: readonly string[];
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
    ...(input.nudgeKinds === undefined || input.nudgeKinds.length === 0
      ? {}
      : { nudgeKinds: [...input.nudgeKinds] }),
    at: input.at
  });
}

interface PreToolNudge {
  readonly message: string;
  readonly kinds: readonly string[];
}

async function buildPreToolNudge(
  store: WorkspaceStore,
  actorId: string,
  paths: readonly string[],
  resources: readonly string[],
  now: string
): Promise<PreToolNudge | null> {
  const [ownerNudge, workNudge] = await Promise.all([
    buildRelatedOwnerNudge(store, actorId, paths, resources, now),
    buildWorkAdoptionNudge(store, actorId, paths, resources)
  ]);
  const nudges = [
    ownerNudge === null ? null : { kind: "owner-overlap", message: ownerNudge },
    workNudge === null ? null : { kind: "work-adoption", message: workNudge }
  ].filter((nudge): nudge is { readonly kind: string; readonly message: string } => nudge !== null);
  return nudges.length === 0
    ? null
    : {
      message: nudges.map((nudge) => nudge.message).join("\n\n"),
      kinds: nudges.map((nudge) => nudge.kind)
    };
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

async function buildWorkAdoptionNudge(
  store: WorkspaceStore,
  actorId: string,
  paths: readonly string[],
  resources: readonly string[]
): Promise<string | null> {
  if (!paths.some(isSpecificPath) && resources.length === 0) {
    return null;
  }

  const activeWork = await readActiveWorkState(store, actorId);
  if (activeWork !== null) {
    return null;
  }

  const presence = await readActorPresence(store, actorId).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  });
  const weaknesses = presence === null ? [] : actorScopeWeaknesses(presence);
  return renderInternalQueueMaintenance({
    summary: "AgentQ work-adoption nudge.",
    afterAction: "Run or resolve the shared-work step if it affects the current edit/handoff, then return to the user's original request and answer the requested artifact first.",
    body: [
      weaknesses.length === 0
        ? "AgentQ sees concrete shared-work activity with no active work frame for this actor."
        : "AgentQ sees concrete shared-work activity while this actor still has weak scope and no active work frame.",
      ...weaknesses.map((weakness) => `- ${weakness.kind}: ${weakness.detail}`),
      `Run: agentq next --actor ${actorId}`,
      "It will print the smallest scope/work command before continuing.",
      "Use the printed command to start or refresh the work frame before the next edit."
    ]
  });
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
  return renderInternalQueueMaintenance({
    summary: "AgentQ owner-overlap nudge.",
    afterAction: "Ask only if this overlap changes the current edit/handoff; otherwise continue local work and answer the user's requested artifact first.",
    body: [
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
    ]
  });
}

function extractActivePaths(payload: PayloadObject, cwd: string): string[] {
  const candidates = new Set<string>();
  collectPathCandidates(payload, candidates);

  const normalizedPaths = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizePathCandidate(candidate, cwd);
    if (normalized !== null) {
      normalizedPaths.add(normalized);
    }
  }

  const paths = [...normalizedPaths].slice(0, 8);

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
    collectPatchPathCandidates(value, candidates);
    if (isCommandLikeKey(key)) {
      collectShellCommandPathCandidates(value, candidates);
    }
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

function collectPatchPathCandidates(value: string, candidates: Set<string>): void {
  if (!value.includes("*** ") || !value.includes(" File: ")) {
    return;
  }

  const fileHeaderPattern = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm;
  for (const match of value.matchAll(fileHeaderPattern)) {
    const candidate = match[1]?.trim();
    if (candidate !== undefined && candidate.length > 0) {
      candidates.add(candidate);
    }
  }

  const moveHeaderPattern = /^\*\*\* Move to: (.+)$/gm;
  for (const match of value.matchAll(moveHeaderPattern)) {
    const candidate = match[1]?.trim();
    if (candidate !== undefined && candidate.length > 0) {
      candidates.add(candidate);
    }
  }
}

function collectShellCommandPathCandidates(command: string, candidates: Set<string>): void {
  const optionPattern = /(?:^|\s)(?:-Path|-LiteralPath|--path|--file|-C(?![A-Za-z]))\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/gi;
  for (const match of command.matchAll(optionPattern)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (candidate !== undefined && looksLikeCommandPathArgument(candidate)) {
      candidates.add(candidate);
    }
  }

  const directCommandPattern = /(?:^|\s)(?:(?:rtk\s+)?read|Get-Content|Test-Path)\s+(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/gi;
  for (const match of command.matchAll(directCommandPattern)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (candidate !== undefined && looksLikeCommandPathArgument(candidate)) {
      candidates.add(candidate);
    }
  }

  const inlineFilePathPattern = /(?:^|[\s"'`])([A-Za-z0-9_.@/-]+[\/\\][A-Za-z0-9_.@/\\-]+\.(?:asmdef|asset|bat|cs|csproj|html|js|json|log|md|prefab|prompt\.txt|ps1|py|result\.txt|sln|slui|stamp|ts|tsx|txt|xml|yaml|yml))(?=$|[\s"'`;|,.])/gi;
  for (const match of command.matchAll(inlineFilePathPattern)) {
    const candidate = match[1];
    if (candidate !== undefined && looksLikeCommandPathArgument(candidate)) {
      candidates.add(candidate);
    }
  }

  for (const rawToken of command.split(/[\s"'`]+/)) {
    const candidate = stripPathTrailingPunctuation(rawToken);
    if (looksLikeCommandPathArgument(candidate)) {
      candidates.add(candidate);
    }
  }

  const quotedPattern = /(?:"([^"]+)"|'([^']+)')/g;
  for (const match of command.matchAll(quotedPattern)) {
    const candidate = match[1] ?? match[2];
    if (candidate !== undefined && looksLikeCommandPathArgument(candidate)) {
      candidates.add(candidate);
    }
  }
}

function isCommandLikeKey(key: string): boolean {
  return /^(command|cmd|script|shell_command)$/i.test(key);
}

function looksLikeCommandPathArgument(value: string): boolean {
  const trimmed = stripPathTrailingPunctuation(value.trim());
  return trimmed.length > 0 &&
    !trimmed.startsWith("-") &&
    !/^[a-z]+:\/\//i.test(trimmed) &&
    isSafePathCandidate(trimmed) &&
    hasConcretePathShape(trimmed) &&
    (isPathLikeValue(trimmed) || PATH_FILE_EXTENSION_PATTERN.test(trimmed));
}

function isPathLikeKey(key: string): boolean {
  return /(^|_)(file|files|path|paths|relative_path|file_path|filepath)$/i.test(key);
}

function isPathLikeValue(value: string): boolean {
  const trimmed = stripPathTrailingPunctuation(value.trim());
  if (/\s/.test(trimmed)) {
    return false;
  }

  return (trimmed.includes("/") || trimmed.includes("\\")) && hasConcretePathShape(trimmed);
}

function normalizePathCandidate(value: string, cwd: string): string | null {
  const trimmed = stripPathTrailingPunctuation(stripPathBoundaryQuotes(value.trim()));
  if (trimmed.length === 0 || trimmed.length > 260) {
    return null;
  }
  if (!isSafePathCandidate(trimmed)) {
    return null;
  }
  if (!hasConcretePathShape(trimmed)) {
    return null;
  }

  const resolved = path.resolve(cwd, trimmed);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return relative.length === 0 ? "." : relative.replace(/\\/g, "/");
}

function stripPathBoundaryQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  return (first === "\"" || first === "'") && last === first
    ? value.slice(1, -1).trim()
    : value;
}

function stripPathTrailingPunctuation(value: string): string {
  return value.replace(/[),\].:]+$/g, "");
}

function hasConcretePathShape(value: string): boolean {
  const normalized = stripPathBoundaryQuotes(value.trim()).replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (normalized === "." || normalized === "..") {
    return normalized === ".";
  }

  if (PATH_FILE_EXTENSION_PATTERN.test(normalized)) {
    return true;
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
    return segments.some((segment) => TRUSTED_WORKSPACE_PATH_ROOTS.has(segment.toLowerCase()));
  }

  const firstSegment = segments[0]?.toLowerCase();
  return firstSegment !== undefined && TRUSTED_WORKSPACE_PATH_ROOTS.has(firstSegment);
}

function isSafePathCandidate(value: string): boolean {
  if (/[<>{}`$*?\[\]\r\n;|&]/.test(value)) {
    return false;
  }

  if (/(^|\s)(?:rtk|rg|grep|git|dotnet|npm|node|pwsh|powershell|agentq|read|Get-Content|Select-String|Test-Path)(?=$|\s)/i.test(value)) {
    return false;
  }

  if (/\s-{1,2}[A-Za-z]/.test(value)) {
    return false;
  }

  return true;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
