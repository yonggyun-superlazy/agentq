import { readdir } from "node:fs/promises";
import path from "node:path";
import { SafeIdSchema } from "../domain/schema.js";
import type { QuestionRecord } from "../domain/types.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";
import { readQuestionRecord } from "./fold.js";

export async function listQuestionInbox(
  store: WorkspaceStore,
  actorId: string
): Promise<readonly QuestionRecord[]> {
  SafeIdSchema.parse(actorId);
  const inboxDir = path.dirname(store.layout.inboxPointerPath(actorId, "__probe__"));
  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const questions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map(async (entry) =>
        await readQuestionRecord(store, entry.name.slice(0, -".yaml".length))
      )
  );
  return questions
    .filter((question) => question.recipientActorId === actorId && question.status === "pending")
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
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
