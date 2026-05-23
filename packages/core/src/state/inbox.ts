import { readdir } from "node:fs/promises";
import type { FoldedMessageState, FoldedRequest } from "./fold.js";
import { foldMessageState } from "./fold.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";

export interface PendingInboxItem {
  readonly state: FoldedMessageState;
  readonly request: FoldedRequest;
}

export async function listInboxItems(
  store: WorkspaceStore,
  actorId: string
): Promise<PendingInboxItem[]> {
  const inboxDir = store.layout.inboxPointerPath(actorId, "__probe__").replace(/__probe__\.yaml$/, "");
  const entries = await readdir(inboxDir).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  });
  const messageIds = entries.map((entry) => entry.replace(/\.yaml$/, "")).sort();
  const openRequests: PendingInboxItem[] = [];
  for (const messageId of messageIds) {
    const state = await foldMessageState(store, messageId);
    const request = state.requests.find((candidate) =>
      candidate.request.to === actorId && candidate.status === "pending"
    );
    if (request !== undefined) {
      openRequests.push({ state, request });
    }
  }

  return openRequests;
}

export async function listPendingInboxItems(
  store: WorkspaceStore,
  actorId: string
): Promise<PendingInboxItem[]> {
  const items = await listInboxItems(store, actorId);
  return items.filter((item) => item.request.blocksReceiverDone);
}
