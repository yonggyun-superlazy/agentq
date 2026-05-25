import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseYamlWithSchema
} from "../domain/schema.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";
import { writeAtomicYaml, writeOnceYaml } from "../store/writeOnce.js";
import {
  ActorWorkPointerSchema,
  WorkEventSchema,
  type ActorWorkPointer,
  type WorkEvent,
  type WorkFrameSpec
} from "./schema.js";
import { renderInternalQueueMaintenance } from "../output/internalEnvelope.js";

export type WorkTerminalStatus = "closed" | "abandoned" | "superseded";
export type WorkStatus = "open" | WorkTerminalStatus;
export type WorkSpecStatus = "current" | "legacy-obsolete";

export interface WorkState {
  readonly workId: string;
  readonly actorId: string;
  readonly parentWorkId: string | null;
  readonly title: string;
  readonly goal: string;
  readonly spec: WorkFrameSpec;
  readonly specStatus: WorkSpecStatus;
  readonly obsoleteReason: string | null;
  readonly paths: readonly string[];
  readonly touchedPaths: readonly string[];
  readonly evidence: readonly string[];
  readonly status: WorkStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly closeSummary: string | null;
}

export interface WorkCheckResult {
  readonly ok: boolean;
  readonly actorId: string;
  readonly activeWork?: WorkState;
  readonly activeStack?: readonly WorkState[];
  readonly parentReturnEvidenceRequired?: ParentReturnEvidenceRequirement;
}

export interface ParentReturnEvidenceRequirement {
  readonly fromWorkId: string;
  readonly since: string;
}

export interface StartWorkInput {
  readonly actorId: string;
  readonly workId?: string;
  readonly title: string;
  readonly goal?: string;
  readonly spec?: StartWorkFrameSpecInput;
  readonly paths: readonly string[];
  readonly parentWorkId?: string | null;
  readonly now: string;
}

export interface StartWorkFrameSpecInput {
  readonly objective?: string;
  readonly slice?: string;
  readonly denominator?: readonly string[];
  readonly passCriteria?: readonly string[];
  readonly nextOperation?: string;
  readonly stopCondition?: string;
}

export interface AppendWorkTouchInput {
  readonly actorId: string;
  readonly workId?: string;
  readonly paths: readonly string[];
  readonly now: string;
}

export interface AppendWorkEvidenceInput {
  readonly actorId: string;
  readonly workId?: string;
  readonly evidence: readonly string[];
  readonly now: string;
}

export interface CloseWorkInput {
  readonly actorId: string;
  readonly workId?: string;
  readonly status?: WorkTerminalStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly now: string;
}

export function createWorkId(): string {
  return `AW-${randomUUID()}`;
}

export function createWorkEventId(): string {
  return `WE-${randomUUID()}`;
}

export async function startWork(store: WorkspaceStore, input: StartWorkInput): Promise<WorkState> {
  const existingActiveWorkId = await readActiveWorkId(store, input.actorId);
  const workId = input.workId ?? createWorkId();
  const parentWorkId = input.parentWorkId === undefined ? existingActiveWorkId : input.parentWorkId;
  const spec = createWorkFrameSpec(input);
  const event: WorkEvent = {
    kind: "work_started",
    id: createWorkEventId(),
    workId,
    actorId: input.actorId,
    parentWorkId,
    title: input.title,
    goal: input.goal ?? spec.objective,
    spec,
    paths: normalizeNonEmpty(input.paths),
    at: input.now
  };

  WorkEventSchema.parse(event);
  await writeOnceYaml(store.layout.workEventPath(workId, event.id), event);
  await writeActivePointer(store, input.actorId, workId, input.now);
  return await readWorkState(store, workId);
}

export async function appendActiveWorkTouch(
  store: WorkspaceStore,
  input: AppendWorkTouchInput
): Promise<WorkState | null> {
  const workId = input.workId ?? await readActiveWorkId(store, input.actorId);
  if (workId === null) {
    return null;
  }

  const event: WorkEvent = {
    kind: "work_touched",
    id: createWorkEventId(),
    workId,
    actorId: input.actorId,
    paths: normalizeNonEmpty(input.paths),
    at: input.now
  };

  await appendWorkEvent(store, event);
  return await readWorkState(store, workId);
}

export async function appendWorkEvidence(
  store: WorkspaceStore,
  input: AppendWorkEvidenceInput
): Promise<WorkState> {
  const workId = await requireTargetWorkId(store, input.actorId, input.workId);
  const evidence = normalizeNonEmpty(input.evidence);
  await assertParentReturnEvidenceQuality(store, input.actorId, workId, evidence);
  const event: WorkEvent = {
    kind: "work_evidence",
    id: createWorkEventId(),
    workId,
    actorId: input.actorId,
    evidence,
    at: input.now
  };

  await appendWorkEvent(store, event);
  await clearParentReturnEvidenceRequirement(store, input.actorId, workId, input.now);
  return await readWorkState(store, workId);
}

export async function closeWork(store: WorkspaceStore, input: CloseWorkInput): Promise<WorkState> {
  const workId = await requireTargetWorkId(store, input.actorId, input.workId);
  const before = await readWorkState(store, workId);
  assertActorOwnsWork(before, input.actorId);
  if (before.status === "closed") {
    throw new Error(`AgentQ work item is already closed: ${workId}`);
  }

  const closeEvidence = normalizeTextValues(input.evidence);
  if (before.evidence.length === 0 && closeEvidence.length === 0) {
    throw new Error("AgentQ work close requires evidence recorded by `work evidence` or `work close --evidence`.");
  }
  const pointer = await readActiveWorkPointer(store, input.actorId);
  if (
    pointer?.activeWorkId === workId &&
    pointer.returnEvidenceSince !== undefined &&
    !hasParentReturnEvidence(closeEvidence)
  ) {
    throw new Error(
      parentReturnEvidenceErrorMessage()
    );
  }

  const event: WorkEvent = {
    kind: "work_closed",
    id: createWorkEventId(),
    workId,
    actorId: input.actorId,
    status: input.status ?? "closed",
    summary: input.summary,
    evidence: closeEvidence,
    at: input.now
  };

  await appendWorkEvent(store, event);
  const after = await readWorkState(store, workId);
  await writeActivePointer(
    store,
    input.actorId,
    after.parentWorkId,
    input.now,
    after.parentWorkId === null
      ? undefined
      : {
        parentReturnEvidenceRequired: {
          fromWorkId: after.workId,
          since: input.now
        }
      }
  );
  return after;
}

export async function readActiveWorkState(
  store: WorkspaceStore,
  actorId: string
): Promise<WorkState | null> {
  const workId = await readActiveWorkId(store, actorId);
  return workId === null ? null : await readWorkState(store, workId);
}

export async function readActiveWorkStack(
  store: WorkspaceStore,
  actorId: string
): Promise<readonly WorkState[]> {
  const active = await readActiveWorkState(store, actorId);
  if (active === null) {
    return [];
  }

  const activeToRoot: WorkState[] = [];
  const seenWorkIds = new Set<string>();
  let current: WorkState | null = active;

  while (current !== null) {
    if (current.actorId !== actorId) {
      throw new Error(`AgentQ work stack frame belongs to another actor: ${current.workId}`);
    }
    if (seenWorkIds.has(current.workId)) {
      throw new Error(`AgentQ work stack has a cycle at ${current.workId}`);
    }

    activeToRoot.push(current);
    seenWorkIds.add(current.workId);
    current = current.parentWorkId === null ? null : await readWorkState(store, current.parentWorkId);
  }

  return activeToRoot.reverse();
}

export async function runWorkDoneCheck(
  store: WorkspaceStore,
  actorId: string
): Promise<WorkCheckResult> {
  const pointer = await readActiveWorkPointer(store, actorId);
  const activeStack = await readActiveWorkStack(store, actorId);
  const activeWork = activeStack[activeStack.length - 1];
  if (activeWork === undefined || activeWork.status !== "open") {
    return { ok: true, actorId };
  }

  const parentReturnEvidenceRequired =
    pointer?.activeWorkId === activeWork.workId &&
    pointer.returnFromWorkId !== undefined &&
    pointer.returnEvidenceSince !== undefined
      ? {
        fromWorkId: pointer.returnFromWorkId,
        since: pointer.returnEvidenceSince
      }
      : undefined;
  return {
    ok: false,
    actorId,
    activeWork,
    activeStack,
    ...(parentReturnEvidenceRequired === undefined ? {} : { parentReturnEvidenceRequired })
  };
}

export function planWorkStopContinuation(result: WorkCheckResult): string {
  if (result.ok || result.activeWork === undefined) {
    return "AgentQ work-check passed.";
  }

  const stack = result.activeStack ?? [result.activeWork];
  return renderInternalQueueMaintenance({
    summary: `AgentQ work-check failed for ${result.actorId}.`,
    afterAction: "Record evidence or close the active work item, then return to the user's original request and answer the requested artifact first.",
    body: [
      "Do not use this work-check reason as the user-facing answer.",
      `AgentQ work-check failed for ${result.actorId}.`,
      `Active work ${result.activeWork.workId} is still open: ${result.activeWork.spec.objective}.`,
      ...renderWorkStackSpecLines(stack, "Active stack"),
      `Run: agentq next --actor ${result.actorId}`,
      "It will print the exact evidence or close command before claiming done."
    ]
  });
}

export function renderWorkStackSpecLines(stack: readonly WorkState[], label = "Work stack"): string[] {
  if (stack.length === 0) {
    return [`${label}: none`];
  }

  return [
    `${label}:`,
    ...stack.flatMap((frame, index) => {
      const marker = index === stack.length - 1 ? "current" : "parent";
      const lines = [
        `  ${index + 1}. ${frame.workId} [${marker}] ${frame.spec.objective}`,
        `     spec: ${frame.specStatus}`
      ];
      if (frame.spec.slice !== undefined) {
        lines.push(`     slice: ${frame.spec.slice}`);
      }
      if (frame.spec.denominator !== undefined) {
        lines.push(`     denominator: ${frame.spec.denominator.join("; ")}`);
      }
      if (frame.spec.passCriteria !== undefined) {
        lines.push(`     pass: ${frame.spec.passCriteria.join("; ")}`);
      }
      if (frame.spec.nextOperation !== undefined) {
        lines.push(`     next: ${frame.spec.nextOperation}`);
      }
      if (frame.spec.stopCondition !== undefined) {
        lines.push(`     stop: ${frame.spec.stopCondition}`);
      }
      if (frame.obsoleteReason !== null) {
        lines.push(`     obsolete: ${frame.obsoleteReason}`);
      }
      return lines;
    })
  ];
}

export async function readWorkState(store: WorkspaceStore, workId: string): Promise<WorkState> {
  const events = await readWorkEvents(store, workId);
  if (events.length === 0) {
    throw new Error(`AgentQ work item has no events: ${workId}`);
  }

  const first = events[0];
  if (first === undefined || first.kind !== "work_started") {
    throw new Error(`AgentQ work item is missing a work_started event: ${workId}`);
  }

  const paths = new Set(first.paths);
  const touchedPaths = new Set(first.paths);
  const evidence: string[] = [];
  let status: WorkState["status"] = "open";
  let updatedAt = first.at;
  let closedAt: string | null = null;
  let closeSummary: string | null = null;

  for (const event of events) {
    if (event.workId !== first.workId) {
      throw new Error(`AgentQ work event belongs to another work item: ${event.id}`);
    }
    if (event.actorId !== first.actorId) {
      throw new Error(`AgentQ work event belongs to another actor: ${event.id}`);
    }

    updatedAt = event.at;

    if (event.kind === "work_touched") {
      for (const touchedPath of event.paths) {
        touchedPaths.add(touchedPath);
      }
      continue;
    }

    if (event.kind === "work_evidence") {
      evidence.push(...event.evidence);
      continue;
    }

    if (event.kind === "work_closed") {
      status = event.status ?? "closed";
      closedAt = event.at;
      closeSummary = event.summary;
      evidence.push(...event.evidence);
    }
  }

  return {
    workId: first.workId,
    actorId: first.actorId,
    parentWorkId: first.parentWorkId,
    title: first.title,
    goal: first.goal,
    ...readWorkFrameSpec(first),
    paths: [...paths].sort(),
    touchedPaths: [...touchedPaths].sort(),
    evidence,
    status,
    startedAt: first.at,
    updatedAt,
    closedAt,
    closeSummary
  };
}

function createWorkFrameSpec(input: StartWorkInput): WorkFrameSpec {
  const objective = nonEmptyOrFallback(input.spec?.objective, input.goal ?? input.title);
  const slice = nonEmptyOptional(input.spec?.slice);
  const denominator = normalizeOptionalNonEmpty(input.spec?.denominator);
  const passCriteria = normalizeOptionalNonEmpty(input.spec?.passCriteria);
  const nextOperation = nonEmptyOptional(input.spec?.nextOperation);
  const stopCondition = nonEmptyOptional(input.spec?.stopCondition);
  const spec: WorkFrameSpec = {
    version: 2,
    objective
  };
  if (slice !== undefined) {
    spec.slice = slice;
  }
  if (denominator !== undefined) {
    spec.denominator = denominator;
  }
  if (passCriteria !== undefined) {
    spec.passCriteria = passCriteria;
  }
  if (nextOperation !== undefined) {
    spec.nextOperation = nextOperation;
  }
  if (stopCondition !== undefined) {
    spec.stopCondition = stopCondition;
  }
  return spec;
}

function readWorkFrameSpec(first: Extract<WorkEvent, { readonly kind: "work_started" }>): Pick<WorkState, "spec" | "specStatus" | "obsoleteReason"> {
  if (first.spec !== undefined) {
    return {
      spec: first.spec,
      specStatus: "current",
      obsoleteReason: null
    };
  }

  return {
    spec: {
      version: 2,
      objective: first.goal,
      slice: first.title,
      stopCondition: "Rebase this legacy title/goal frame into an explicit v2 work spec before relying on it for parent-goal restoration."
    },
    specStatus: "legacy-obsolete",
    obsoleteReason: "Legacy work_started event has no v2 frame spec; keep it visible only as obsolete stack context until it is closed or rebased."
  };
}

function normalizeOptionalNonEmpty(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const normalized = normalizeNonEmpty(values);
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeTextValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function nonEmptyOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function nonEmptyOrFallback(value: string | undefined, fallback: string): string {
  return nonEmptyOptional(value) ?? fallback;
}

async function appendWorkEvent(store: WorkspaceStore, event: WorkEvent): Promise<void> {
  WorkEventSchema.parse(event);
  const state = await readWorkState(store, event.workId);
  assertActorOwnsWork(state, event.actorId);
  if (state.status !== "open") {
    throw new Error(`AgentQ work item is already terminal: ${event.workId}`);
  }
  await writeOnceYaml(store.layout.workEventPath(event.workId, event.id), event);
}

async function readWorkEvents(store: WorkspaceStore, workId: string): Promise<WorkEvent[]> {
  const eventsDir = store.layout.workEventPath(workId, "__probe__").replace(/__probe__\.yaml$/, "");
  const entries = await readdir(eventsDir);
  const events = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".yaml"))
      .map(async (entry) => WorkEventSchema.parse(parseYamlWithSchema(
        WorkEventSchema,
        await readFile(path.join(eventsDir, entry), "utf8")
      )))
  );

  return events.sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      workEventPriority(left).localeCompare(workEventPriority(right)) ||
      left.id.localeCompare(right.id)
  );
}

function workEventPriority(event: WorkEvent): string {
  if (event.kind === "work_started") {
    return "0";
  }
  if (event.kind === "work_closed") {
    return "2";
  }
  return "1";
}

async function readActiveWorkPointer(store: WorkspaceStore, actorId: string): Promise<ActorWorkPointer | null> {
  try {
    const pointer = parseYamlWithSchema(
      ActorWorkPointerSchema,
      await readFile(store.layout.actorWorkPointerPath(actorId), "utf8")
    );
    if (pointer.actorId !== actorId) {
      throw new Error(`AgentQ active work pointer belongs to another actor: ${actorId}`);
    }
    return pointer;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

async function readActiveWorkId(store: WorkspaceStore, actorId: string): Promise<string | null> {
  return (await readActiveWorkPointer(store, actorId))?.activeWorkId ?? null;
}

async function requireTargetWorkId(
  store: WorkspaceStore,
  actorId: string,
  workId: string | undefined
): Promise<string> {
  const targetWorkId = workId ?? await readActiveWorkId(store, actorId);
  if (targetWorkId === null) {
    throw new Error(`AgentQ actor has no active work item: ${actorId}`);
  }

  return targetWorkId;
}

async function writeActivePointer(
  store: WorkspaceStore,
  actorId: string,
  activeWorkId: string | null,
  updatedAt: string,
  options: {
    readonly parentReturnEvidenceRequired?: ParentReturnEvidenceRequirement;
  } = {}
): Promise<void> {
  const pointer: ActorWorkPointer = {
    actorId,
    activeWorkId,
    updatedAt,
    ...(activeWorkId === null || options.parentReturnEvidenceRequired === undefined
      ? {}
      : {
        returnFromWorkId: options.parentReturnEvidenceRequired.fromWorkId,
        returnEvidenceSince: options.parentReturnEvidenceRequired.since
      })
  };
  ActorWorkPointerSchema.parse(pointer);
  await writeAtomicYaml(store.layout.actorWorkPointerPath(actorId), pointer);
}

async function clearParentReturnEvidenceRequirement(
  store: WorkspaceStore,
  actorId: string,
  workId: string,
  updatedAt: string
): Promise<void> {
  const pointer = await readActiveWorkPointer(store, actorId);
  if (
    pointer?.activeWorkId !== workId ||
    pointer.returnEvidenceSince === undefined
  ) {
    return;
  }

  await writeActivePointer(store, actorId, workId, updatedAt);
}

async function assertParentReturnEvidenceQuality(
  store: WorkspaceStore,
  actorId: string,
  workId: string,
  evidence: readonly string[]
): Promise<void> {
  const pointer = await readActiveWorkPointer(store, actorId);
  if (
    pointer?.activeWorkId !== workId ||
    pointer.returnEvidenceSince === undefined ||
    hasParentReturnEvidence(evidence)
  ) {
    return;
  }

  throw new Error(parentReturnEvidenceErrorMessage());
}

function parentReturnEvidenceErrorMessage(): string {
  return (
    "AgentQ parent-return evidence must say the restored parent work was rechecked after the child closed. " +
    "Include parent return plus parent denominator, pass, next, or objective evidence."
  );
}

function hasParentReturnEvidence(evidence: readonly string[]): boolean {
  const text = evidence.join(" ").toLowerCase();
  if (text.length === 0) {
    return false;
  }

  const returnCue = /parent[- ]return|returned to parent|after child|child close|child closed|restored parent|parent frame|parent work/.test(text);
  const parentCue = /\bparent\b/.test(text);
  const recheckCue = /denominator|pass criteria|\bpass\b|next operation|\bnext\b|objective|recheck|rechecked|reviewed|remaining/.test(text);
  return returnCue && parentCue && recheckCue;
}

function assertActorOwnsWork(state: WorkState, actorId: string): void {
  if (state.actorId !== actorId) {
    throw new Error(`AgentQ work item belongs to another actor: ${state.workId}`);
  }
}

function normalizeNonEmpty(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
  if (normalized.length === 0) {
    throw new Error("AgentQ work event requires at least one non-empty value.");
  }

  return normalized;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
