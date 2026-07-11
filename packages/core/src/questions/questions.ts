import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { normalizeClaimSnapshot } from "../claims/claims.js";
import { QuestionRecordSchema, SafeIdSchema } from "../domain/schema.js";
import type { ClaimSnapshot, QuestionRecord, QuestionStatus } from "../domain/types.js";
import { findOwners } from "../routing/owners.js";
import { readQuestionRecord } from "../state/fold.js";
import { listQuestionInbox } from "../state/inbox.js";
import { findOpaqueSessionBindingByActorId } from "../store/sessionBinding.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";
import { isFileAlreadyExistsError, writeOnceYaml } from "../store/writeOnce.js";

export type QuestionRoutingErrorCode =
  | "self_recipient"
  | "sender_unregistered"
  | "unsupported_recipient"
  | "empty_scope";

export class QuestionRoutingError extends Error {
  public constructor(public readonly code: QuestionRoutingErrorCode, message: string) {
    super(message);
  }
}

export interface CreateQuestionInput {
  readonly senderActorId: string;
  readonly recipientActorId: string;
  readonly question: string;
  readonly scope: ClaimSnapshot;
  readonly now?: string;
}

export async function createQuestion(
  store: WorkspaceStore,
  input: CreateQuestionInput
): Promise<QuestionRecord> {
  SafeIdSchema.parse(input.senderActorId);
  SafeIdSchema.parse(input.recipientActorId);
  if (input.senderActorId === input.recipientActorId) {
    throw new QuestionRoutingError("self_recipient", "Question sender and recipient must differ.");
  }
  if ((await findOpaqueSessionBindingByActorId(store, input.senderActorId)) === null) {
    throw new QuestionRoutingError("sender_unregistered", "Question sender is not registered.");
  }

  const scope = normalizeClaimSnapshot(store, input.scope);
  if (scope.paths.length === 0 && scope.resources.length === 0 && scope.contracts.length === 0) {
    throw new QuestionRoutingError("empty_scope", "Question requires at least one declared scope value.");
  }
  const owners = await findOwners(store, input.senderActorId, scope);
  if (!owners.some((owner) => owner.actorId === input.recipientActorId)) {
    throw new QuestionRoutingError(
      "unsupported_recipient",
      "Question recipient is not routeable with an overlapping claim."
    );
  }

  const now = input.now ?? new Date().toISOString();
  const record = QuestionRecordSchema.parse({
    id: `question_${randomBytes(16).toString("hex")}`,
    senderActorId: input.senderActorId,
    recipientActorId: input.recipientActorId,
    question: input.question,
    scope,
    status: "pending",
    createdAt: now,
    updatedAt: now
  });

  await writeOnceYaml(store.layout.questionPath(record.id), record);
  try {
    await writeOnceYaml(store.layout.inboxPointerPath(record.recipientActorId, record.id), {
      questionId: record.id
    });
  } catch (error) {
    await rm(store.layout.questionDir(record.id), { recursive: true, force: true });
    throw error;
  }
  return record;
}

export async function answerQuestion(
  store: WorkspaceStore,
  questionId: string,
  actorId: string,
  answer: string,
  now = new Date().toISOString()
): Promise<QuestionRecord> {
  const trimmedAnswer = answer.trim();
  if (trimmedAnswer.length === 0) {
    throw new Error("Question answer may not be empty.");
  }
  return await transitionRecipientQuestion(store, questionId, actorId, "answered", now, trimmedAnswer);
}

export async function declineQuestionAsNotMine(
  store: WorkspaceStore,
  questionId: string,
  actorId: string,
  now = new Date().toISOString()
): Promise<QuestionRecord> {
  return await transitionRecipientQuestion(store, questionId, actorId, "not_mine", now);
}

export async function cancelQuestion(
  store: WorkspaceStore,
  questionId: string,
  actorId: string,
  now = new Date().toISOString()
): Promise<QuestionRecord> {
  const current = await readQuestionRecord(store, questionId);
  if (current.senderActorId !== actorId) {
    throw new Error("Only the question sender may cancel it.");
  }
  return await writeTerminalQuestion(store, current, "cancelled", now);
}

export async function listInbox(
  store: WorkspaceStore,
  actorId: string
): Promise<readonly QuestionRecord[]> {
  return await listQuestionInbox(store, actorId);
}

async function transitionRecipientQuestion(
  store: WorkspaceStore,
  questionId: string,
  actorId: string,
  status: "answered" | "not_mine",
  now: string,
  answer?: string
): Promise<QuestionRecord> {
  const current = await readQuestionRecord(store, questionId);
  if (current.recipientActorId !== actorId) {
    throw new Error("Only the question recipient may answer or decline it.");
  }
  return await writeTerminalQuestion(store, current, status, now, answer);
}

async function writeTerminalQuestion(
  store: WorkspaceStore,
  current: QuestionRecord,
  status: Exclude<QuestionStatus, "pending">,
  now: string,
  answer?: string
): Promise<QuestionRecord> {
  if (current.status !== "pending") {
    throw new Error(`Question is already terminal: ${current.status}`);
  }
  const next = QuestionRecordSchema.parse({
    ...current,
    status,
    ...(answer === undefined ? {} : { answer }),
    updatedAt: now
  });
  try {
    await writeOnceYaml(store.layout.questionTerminalPath(current.id), next);
  } catch (error) {
    if (isFileAlreadyExistsError(error)) {
      const terminal = await readQuestionRecord(store, current.id);
      throw new Error(`Question is already terminal: ${terminal.status}`);
    }
    throw error;
  }
  return next;
}
