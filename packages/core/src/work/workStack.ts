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
  type WorkEvent
} from "./schema.js";

export interface WorkState {
  readonly workId: string;
  readonly actorId: string;
  readonly parentWorkId: string | null;
  readonly title: string;
  readonly goal: string;
  readonly paths: readonly string[];
  readonly touchedPaths: readonly string[];
  readonly evidence: readonly string[];
  readonly status: "open" | "closed";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly closeSummary: string | null;
}

export interface WorkCheckResult {
  readonly ok: boolean;
  readonly actorId: string;
  readonly activeWork?: WorkState;
}

export interface StartWorkInput {
  readonly actorId: string;
  readonly workId?: string;
  readonly title: string;
  readonly goal?: string;
  readonly paths: readonly string[];
  readonly parentWorkId?: string | null;
  readonly now: string;
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
  const event: WorkEvent = {
    kind: "work_started",
    id: createWorkEventId(),
    workId,
    actorId: input.actorId,
    parentWorkId,
    title: input.title,
    goal: input.goal ?? input.title,
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
  const event: WorkEvent = {
    kind: "work_evidence",
    id: createWorkEventId(),
    workId,
    actorId: input.actorId,
    evidence: normalizeNonEmpty(input.evidence),
    at: input.now
  };

  await appendWorkEvent(store, event);
  return await readWorkState(store, workId);
}

export async function closeWork(store: WorkspaceStore, input: CloseWorkInput): Promise<WorkState> {
  const workId = await requireTargetWorkId(store, input.actorId, input.workId);
  const before = await readWorkState(store, workId);
  assertActorOwnsWork(before, input.actorId);
  if (before.status === "closed") {
    throw new Error(`AgentQ work item is already closed: ${workId}`);
  }

  const closeEvidence = [...input.evidence];
  if (before.evidence.length === 0 && closeEvidence.length === 0) {
    throw new Error("AgentQ work close requires evidence recorded by `work evidence` or `work close --evidence`.");
  }

  const event: WorkEvent = {
    kind: "work_closed",
    id: createWorkEventId(),
    workId,
    actorId: input.actorId,
    summary: input.summary,
    evidence: closeEvidence,
    at: input.now
  };

  await appendWorkEvent(store, event);
  const after = await readWorkState(store, workId);
  await writeActivePointer(store, input.actorId, after.parentWorkId, input.now);
  return after;
}

export async function readActiveWorkState(
  store: WorkspaceStore,
  actorId: string
): Promise<WorkState | null> {
  const workId = await readActiveWorkId(store, actorId);
  return workId === null ? null : await readWorkState(store, workId);
}

export async function runWorkDoneCheck(
  store: WorkspaceStore,
  actorId: string
): Promise<WorkCheckResult> {
  const activeWork = await readActiveWorkState(store, actorId);
  if (activeWork === null || activeWork.status === "closed") {
    return { ok: true, actorId };
  }

  return { ok: false, actorId, activeWork };
}

export function planWorkStopContinuation(result: WorkCheckResult): string {
  if (result.ok || result.activeWork === undefined) {
    return "AgentQ work-check passed.";
  }

  return [
    `AgentQ work-check failed for ${result.actorId}.`,
    `Active work ${result.activeWork.workId} is still open: ${result.activeWork.title}.`,
    "Record evidence with `agentq work evidence --actor <agentq-actor-id> --evidence \"...\"`.",
    "Then close it with `agentq work close --actor <agentq-actor-id> --summary \"...\"` before claiming done."
  ].join(" ");
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
      status = "closed";
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

async function appendWorkEvent(store: WorkspaceStore, event: WorkEvent): Promise<void> {
  WorkEventSchema.parse(event);
  const state = await readWorkState(store, event.workId);
  assertActorOwnsWork(state, event.actorId);
  if (state.status === "closed") {
    throw new Error(`AgentQ work item is already closed: ${event.workId}`);
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

async function readActiveWorkId(store: WorkspaceStore, actorId: string): Promise<string | null> {
  try {
    const pointer = parseYamlWithSchema(
      ActorWorkPointerSchema,
      await readFile(store.layout.actorWorkPointerPath(actorId), "utf8")
    );
    if (pointer.actorId !== actorId) {
      throw new Error(`AgentQ active work pointer belongs to another actor: ${actorId}`);
    }
    return pointer.activeWorkId;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
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
  updatedAt: string
): Promise<void> {
  const pointer: ActorWorkPointer = {
    actorId,
    activeWorkId,
    updatedAt
  };
  ActorWorkPointerSchema.parse(pointer);
  await writeAtomicYaml(store.layout.actorWorkPointerPath(actorId), pointer);
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
