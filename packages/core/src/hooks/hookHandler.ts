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
  readActiveWorkStack,
  readActiveWorkState,
  renderWorkStackCompactLines,
  runWorkDoneCheck
} from "../work/workStack.js";
import { readDiagnosticEvents, tryAppendDiagnosticEvent } from "../diagnostics/ringLog.js";
import { actorScopeWeaknesses } from "../state/scopeCheck.js";
import { renderInternalQueueMaintenance } from "../output/internalEnvelope.js";

export type HookAdapter = "codex" | "claude-code" | "copilot-cli";
export type HookRuntimeEvent = "session-start" | "pre-tool" | "stop";

const UNITY_EXECUTABLE_PATTERN = /(^|[\/\s"';&|])unity(?:\.exe)?(?=$|[\s"';&|])/i;
const PATH_FILE_EXTENSION_PATTERN = /\.(?:asmdef|asset|bat|cs|csproj|html|js|json|log|md|prefab|prompt\.txt|ps1|py|result\.txt|sln|slui|stamp|ts|tsx|txt|xml|yaml|yml)$/i;
const WORK_STACK_CONTEXT_REPEAT_SUPPRESSION_MS = 30 * 60 * 1000;
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
    const preToolDecision = preToolNudge?.kinds.includes("work-adoption") === true
      ? "block"
      : preToolNudge === null
        ? "allow"
        : "context";
    await writeHookDiagnostic(store, {
      actorId,
      adapter: options.adapter,
      event: options.event,
      sessionId,
      toolName: toolNameFromPayload(payload),
      toolMode: mutatingTool ? "mutating" : "read-only",
      paths: hookPaths,
      resources: hookResources,
      ignoredCommands: resourceInference.ignoredCommands,
      nudge: preToolNudge !== null,
      nudgeKinds: preToolNudge?.kinds ?? [],
      note: preToolNudge?.note,
      decision: preToolDecision,
      at: options.now
    });
    if (preToolNudge?.kinds.includes("work-adoption") === true) {
      return {
        code: 0,
        stdout: `${JSON.stringify(blockOutput(options.adapter, preToolNudge.message))}\n`,
        stderr: ""
      };
    }

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
    toolMode: "stop",
    paths: stopPaths,
    resources: stopResources,
    ignoredCommands: stopResourceInference.ignoredCommands,
    at: options.now
  });

  const stopHookActive = booleanField(payload, "stop_hook_active");
  const done = await runDoneCheck(store, actorId);
  const decision = planStopContinuation(done, stopHookActive);
  if (decision.decision === "block") {
    return {
      code: 0,
      stdout: `${JSON.stringify(blockOutput(options.adapter, decision.reason))}\n`,
      stderr: ""
    };
  }

  const workDone = await runWorkDoneCheck(store, actorId);
  // Same loop guard as the queue gate: block a stop attempt at most once.
  // Re-blocking cannot close a work frame the agent already failed to close,
  // and the harness force-overrides after repeated blocks.
  if (!workDone.ok && !stopHookActive) {
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

  try {
    await appendActiveWorkTouch(store, {
      actorId,
      paths: specificPaths,
      now
    });
  } catch (error) {
    if (isWorkTouchBeforeEvidenceError(error)) {
      return;
    }

    throw error;
  }
}

function isWorkTouchBeforeEvidenceError(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("requires qualitative context evidence");
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
      try {
        await refreshActorPresence(store, {
          actorId: input.actorId,
          cwd: input.cwd,
          activePaths: [],
          observedPaths: activePaths.filter(isSpecificPath),
          responsibilities: [],
          mergeObservedPaths: true,
          now: input.now
        });
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        await createOrRefreshSessionBinding(store, {
          adapter: input.adapter,
          sessionId: input.sessionId,
          cwd: input.cwd,
          activePaths: ["."],
          observedPaths: activePaths.filter(isSpecificPath),
          responsibilities: [`${input.adapter} read scope`],
          summary: `${input.adapter} read scope`,
          now: input.now
        });
      }
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
    afterAction: "Use only for coordination; answer the user's requested artifact first.",
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
  if (/(write|edit|apply|patch|delete|move|rename)/i.test(toolName)) {
    return true;
  }
  if (!/(bash|shell|command)/i.test(toolName)) {
    return false;
  }

  const commands = new Set<string>();
  collectCommandCandidates(payload, commands);
  if (commands.size === 0) {
    return true;
  }

  const commandList = [...commands];
  if (commandList.every(isStandaloneAgentQControlCommand)) {
    return false;
  }

  return !commandList.every(isReadOnlyShellCommand);
}

function isReadOnlyShellCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return false;
  }
  if (/(^|[\s"';&|])(?:rm|del|erase|rmdir|mkdir|touch|set-content|add-content|out-file|remove-item|move-item|copy-item|new-item|git\s+(?:add|commit|push|pull|merge|rebase|checkout|switch|reset)|npm\s+(?:install|publish)|pnpm\s+(?:install|publish)|corepack\s+pnpm\s+(?:install|publish)|apply_patch)\b/i.test(normalized)) {
    return false;
  }

  if (isReadOnlyAgentQMetaCommand(normalized)) {
    return true;
  }
  if (isReadOnlyQualityScorecardCommand(normalized)) {
    return true;
  }
  if (isReadOnlyPowerShellCommand(normalized)) {
    return true;
  }

  return /(^|[\s"';&|])(?:(?:rtk\s+)?(?:read|rg|git\s+(?:status|diff|show|log|ls-files)|npm\s+(?:list|view|whoami)|agentq\s+(?:status|diag|owners|doctor|inbox|next|work\s+(?:status|start|evidence|close|edit)))|(?:get-content|select-string|get-childitem|test-path)\b)/i.test(normalized);
}

function isReadOnlyPowerShellCommand(command: string): boolean {
  if (!/(^|[\s"';&|])(?:rtk\s+)?(?:pwsh|powershell)(?:\.exe)?\b/i.test(command)) {
    return false;
  }
  if (!/\s-(?:command|c)\b/i.test(command)) {
    return false;
  }

  return /\b(?:Get-Content|Select-String|Get-ChildItem|Test-Path|ForEach-Object|Where-Object|Sort-Object|Group-Object|Select-Object|Measure-Object|ConvertFrom-Json|ConvertTo-Json)\b/i.test(command);
}

function isReadOnlyAgentQMetaCommand(command: string): boolean {
  const normalizedCommand = command.replace(/\\/g, "/");
  const readOnlySubcommands = "actors|diag|doctor|inbox|next|owners|status|wake|work\\s+(?:status|start|evidence|close|edit)";
  return new RegExp(`(^|[\\s"';&|])agentq(?:\\.cmd|\\.ps1|\\.bat|\\.exe)?\\s+(${readOnlySubcommands})\\b`, "i").test(normalizedCommand) ||
    new RegExp(`(^|[\\s"';&|])(?:node(?:\\.exe)?|tsx(?:\\.cmd|\\.ps1|\\.bat|\\.exe)?)\\s+[^\\s"';&|]*agentq[^\\s"';&|]*/packages/cli/(?:dist/main\\.js|src/main\\.ts)\\s+(${readOnlySubcommands})\\b`, "i").test(normalizedCommand);
}

function isReadOnlyQualityScorecardCommand(command: string): boolean {
  const normalizedCommand = command.replace(/\\/g, "/").replace(/\s+/g, " ").trim();
  if (normalizedCommand.length === 0 || /(?:&&|\|\||[;|<>])/.test(normalizedCommand)) {
    return false;
  }
  if (!/(^|\s)-B(\s|$)/.test(normalizedCommand)) {
    return false;
  }

  return /^(?:rtk\s+)?(?:python(?:\.exe)?|py(?:\.exe)?)\s+(?:-[^\s]+\s+)*(?:[A-Za-z]:)?\/?(?:[^\s"']+\/)*docs\/quality-experiments\/summarize_quality_scorecard\.py\b/i.test(normalizedCommand);
}

function isStandaloneAgentQControlCommand(command: string): boolean {
  const normalizedCommand = command.replace(/\\/g, "/").replace(/\s+/g, " ").trim();
  if (normalizedCommand.length === 0 || /(?:&&|\|\||[;|])/.test(normalizedCommand)) {
    return false;
  }

  const controlSubcommands = "accept-blocked|actors|block|diag|doctor|done-check|enter|follow-up|inbox|next|note|owners|question|respond|scope-check|status|supersede|wake|work";
  return new RegExp(`(^|[\\s"'])agentq(?:\\.cmd|\\.ps1|\\.bat|\\.exe)?\\s+(${controlSubcommands})\\b`, "i").test(normalizedCommand) ||
    new RegExp(`(^|[\\s"'])(?:node(?:\\.exe)?|tsx(?:\\.cmd|\\.ps1|\\.bat|\\.exe)?)\\s+[^\\s"']*agentq[^\\s"']*/packages/cli/(?:dist/main\\.js|src/main\\.ts)\\s+(${controlSubcommands})\\b`, "i").test(normalizedCommand);
}

async function writeHookDiagnostic(
  store: WorkspaceStore,
  input: {
    readonly actorId: string;
    readonly adapter: HookAdapter;
    readonly event: HookRuntimeEvent;
    readonly sessionId: string;
    readonly toolName?: string | undefined;
    readonly toolMode?: "read-only" | "mutating" | "stop" | undefined;
    readonly paths: readonly string[];
    readonly resources: readonly string[];
    readonly ignoredCommands: readonly string[];
    readonly nudge?: boolean;
    readonly nudgeKinds?: readonly string[];
    readonly note?: string | undefined;
    readonly decision?: "allow" | "block" | "context";
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
    ...(input.toolMode === undefined ? {} : { toolMode: input.toolMode }),
    paths: [...input.paths],
    resources: [...input.resources],
    ignoredCommands: [...input.ignoredCommands],
    ...(input.nudge === undefined ? {} : { nudge: input.nudge }),
    ...(input.nudgeKinds === undefined || input.nudgeKinds.length === 0
      ? {}
      : { nudgeKinds: [...input.nudgeKinds] }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    at: input.at
  });
}

interface PreToolNudge {
  readonly message: string;
  readonly kinds: readonly string[];
  readonly note?: string | undefined;
}

interface WorkStackContext {
  readonly message: string;
  readonly note: string;
}

interface PreToolNudgePart {
  readonly kind: string;
  readonly message: string;
  readonly note?: string | undefined;
}

async function buildPreToolNudge(
  store: WorkspaceStore,
  actorId: string,
  paths: readonly string[],
  resources: readonly string[],
  now: string
): Promise<PreToolNudge | null> {
  const [ownerNudge, workNudge, stackNudge] = await Promise.all([
    buildRelatedOwnerNudge(store, actorId, paths, resources, now),
    buildWorkAdoptionNudge(store, actorId, paths, resources),
    buildActiveWorkStackContext(store, actorId, now)
  ]);
  const nudges: PreToolNudgePart[] = [];
  if (ownerNudge !== null) {
    nudges.push({ kind: "owner-overlap", message: ownerNudge });
  }
  if (workNudge !== null) {
    nudges.push({ kind: "work-adoption", message: workNudge });
  }
  if (
    stackNudge !== null &&
    (ownerNudge === null || stackNudge.note.includes("evidence-required"))
  ) {
    nudges.push({ kind: "work-stack", message: stackNudge.message, note: stackNudge.note });
  }
  return nudges.length === 0
    ? null
    : {
      message: nudges.map((nudge) => nudge.message).join("\n\n"),
      kinds: nudges.map((nudge) => nudge.kind),
      note: nudges.map((nudge) => "note" in nudge ? nudge.note : undefined)
        .filter((note): note is string => note !== undefined)
        .join("; ") || undefined
    };
}

async function buildActiveWorkStackContext(
  store: WorkspaceStore,
  actorId: string,
  now: string
): Promise<WorkStackContext | null> {
  const stack = await readActiveWorkStack(store, actorId);
  if (stack.length === 0) {
    return null;
  }

  const current = stack[stack.length - 1];
  if (current !== undefined && current.evidence.length === 0) {
    return {
      message: renderInternalQueueMaintenance({
        summary: "Record active-work context evidence.",
        afterAction: "Record evidence, retry the tool, then answer the user's current artifact first.",
        body: [
          `Active work has no context evidence yet; events recorded: ${current.eventCount}.`,
          "Evidence needs: frame, observed basis, touched paths/resources, next check.",
          ...renderWorkStackCompactLines(stack, "Active objective")
        ]
      }),
      note: workStackContextSignature(stack, "evidence-required")
    };
  }

  const signature = workStackContextSignature(stack, "active-context");
  if (await hasRecentWorkStackContextDiagnostic(store, actorId, signature, now)) {
    return null;
  }

  return {
    message: renderInternalQueueMaintenance({
      summary: "Active shared-work context.",
      afterAction: "Use as ordering context only; answer the user's current artifact first.",
      body: [
        ...renderWorkStackCompactLines(stack, "Active objective")
      ]
    }),
    note: signature
  };
}

async function hasRecentWorkStackContextDiagnostic(
  store: WorkspaceStore,
  actorId: string,
  signature: string,
  now: string
): Promise<boolean> {
  let events;
  try {
    events = await readDiagnosticEvents(store, 500);
  } catch {
    return false;
  }

  const nowTime = Date.parse(now);
  for (const event of [...events].reverse()) {
    if (
      event.actorId !== actorId ||
      event.event !== "pre-tool" ||
      event.nudgeKinds?.includes("work-stack") !== true ||
      event.note === undefined ||
      !diagnosticNoteIncludes(event.note, signature)
    ) {
      continue;
    }

    const eventTime = Date.parse(event.at);
    return Number.isNaN(nowTime) ||
      Number.isNaN(eventTime) ||
      nowTime - eventTime <= WORK_STACK_CONTEXT_REPEAT_SUPPRESSION_MS;
  }

  return false;
}

function diagnosticNoteIncludes(note: string, signature: string): boolean {
  return note.split(";").map((part) => part.trim()).includes(signature);
}

function workStackContextSignature(stack: readonly { readonly workId: string; readonly evidence: readonly string[] }[], reason: string): string {
  return `work-stack:${reason}:${stack.map((frame) => `${frame.workId}:${frame.evidence.length}`).join(">")}`;
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
    summary: "Start active work for this mutating step.",
    afterAction: "Start/refresh work, retry the tool, then answer the user's current artifact first.",
    body: [
      weaknesses.length === 0
        ? "No active work frame for this mutating activity."
        : "Weak scope and no active work frame for this mutating activity.",
      ...weaknesses.map((weakness) => `- ${workAdoptionWeaknessLabel(weakness.kind)}: ${weakness.detail}`),
      "Use the shared-work helper for the exact command."
    ]
  });
}

function renderRelatedOwnerNudge(
  actorId: string,
  pathMatches: readonly ActivePathOwnerMatch[],
  resourceMatches: readonly ActiveResourceOwnerMatch[]
): string {
  const firstResource = resourceMatches[0]?.activeResource;
  const firstPath = pathMatches[0]?.queriedPath;
  const routeArg = firstResource !== undefined
    ? `--resource ${firstResource}`
    : `--path ${firstPath ?? "<path>"}`;
  return renderInternalQueueMaintenance({
    summary: "Possible owner overlap.",
    afterAction: "Preserve the user's requested artifact; continue unless this is a real conflict.",
    body: [
      "A related active owner exists; ownership routes responsibility, not locks.",
      ...pathMatches.map(
        (match) =>
          `- path ${match.activePath}; responsibility: ${match.actor.responsibilities.join(", ")}`
      ),
      ...resourceMatches.map(
        (match) =>
          `- resource ${match.activeResource}; responsibility: ${match.actor.responsibilities.join(", ")}`
      ),
      "If this changes another actor's contract or blocks work, ask a required question. If it is only context, send a note. Otherwise continue.",
      `- inspect owners: agentq owners --actor ${actorId} ${routeArg}`,
      `- required decision: agentq question --actor ${actorId} --to <owner-actor-id> ${routeArg} --question "<decision needed>" --expect "<answer with evidence>"`,
      `- non-blocking context: agentq note --actor ${actorId} --to <owner-actor-id> ${routeArg} --note "<context or handoff evidence>"`
    ]
  });
}

function workAdoptionWeaknessLabel(kind: string): string {
  if (kind === "broad_path") {
    return "scope";
  }
  if (kind === "generic_responsibility") {
    return "responsibility";
  }
  return "scope";
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
  const subcommands = "accept-blocked|actors|block|diag|doctor|done-check|enter|follow-up|hook|inbox|install|note|owners|question|respond|scope-check|state|status|supersede|uninstall|wake|work";
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
  if ((first === "\"" || first === "'") && last === first) {
    return value.slice(1, -1).trim();
  }

  return value.replace(/^["']+|["']+$/g, "").trim();
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
  if (/[<>{}`$*?\[\]\r\n;|&"']/.test(value)) {
    return false;
  }

  if (/^[+!]/.test(value)) {
    return false;
  }

  if (/[()]/.test(value)) {
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
