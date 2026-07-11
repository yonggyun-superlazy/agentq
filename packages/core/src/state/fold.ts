import { readFile } from "node:fs/promises";
import { parseYamlWithSchema, QuestionRecordSchema, SafeIdSchema } from "../domain/schema.js";
import type { QuestionRecord, QuestionStatus } from "../domain/types.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";

export interface FoldedQuestionState {
  readonly question: QuestionRecord;
  readonly status: QuestionStatus;
  readonly actionable: boolean;
  readonly terminal: boolean;
}

export function foldQuestion(question: QuestionRecord): FoldedQuestionState {
  const parsed = QuestionRecordSchema.parse(question);
  return {
    question: parsed,
    status: parsed.status,
    actionable: parsed.status === "pending",
    terminal: parsed.status !== "pending"
  };
}

export async function foldQuestionState(
  store: WorkspaceStore,
  questionId: string
): Promise<FoldedQuestionState> {
  return foldQuestion(await readQuestionRecord(store, questionId));
}

export async function readQuestionRecord(
  store: WorkspaceStore,
  questionId: string
): Promise<QuestionRecord> {
  SafeIdSchema.parse(questionId);
  try {
    return parseYamlWithSchema(
      QuestionRecordSchema,
      await readFile(store.layout.questionTerminalPath(questionId), "utf8")
    );
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
  return parseYamlWithSchema(
    QuestionRecordSchema,
    await readFile(store.layout.questionPath(questionId), "utf8")
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
