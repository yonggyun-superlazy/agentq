import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  EventSchema,
  MessageSchema,
  parseYamlWithSchema,
  RequiredRequestSchema
} from "../domain/schema.js";
import type { AgentQEvent, Message, RequiredRequest, ResponseStatus } from "../domain/types.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";

export type FoldedRequestStatus = "pending" | ResponseStatus | "superseded";

export interface FoldedRequest {
  readonly request: RequiredRequest;
  readonly status: FoldedRequestStatus;
  readonly terminalEvent: AgentQEvent | null;
  readonly blocksReceiverDone: boolean;
  readonly blocksSenderDone: boolean;
}

export interface FoldedMessageState {
  readonly message: Message;
  readonly requests: readonly FoldedRequest[];
  readonly events: readonly AgentQEvent[];
}

export async function foldMessageState(
  store: WorkspaceStore,
  messageId: string
): Promise<FoldedMessageState> {
  const message = parseYamlWithSchema(
    MessageSchema,
    await readFile(store.layout.messagePath(messageId), "utf8")
  );
  const requests = await readRequestFiles(path.join(store.layout.messageDir(messageId), "requests"));
  const events = await readEventFiles(path.join(store.layout.messageDir(messageId), "events"));

  return {
    message,
    requests: requests.map((request) => foldRequest(request, events, message.createdBy)),
    events
  };
}

export function foldRequest(
  request: RequiredRequest,
  events: readonly AgentQEvent[],
  senderActorId = ""
): FoldedRequest {
  const responseEvent =
    events
      .filter((event) => event.kind === "response")
      .filter((event) => event.messageId === request.messageId && event.actorId === request.to)
      .at(-1) ?? null;
  const supersedeEvent =
    responseEvent === null
      ? events
          .filter((event) => event.kind === "supersede")
          .filter(
            (event) =>
              event.messageId === request.messageId &&
              event.actorId === senderActorId &&
              event.targetActorId === request.to
          )
          .at(-1) ?? null
      : null;
  const terminalEvent = responseEvent ?? supersedeEvent;
  const status = responseEvent?.status ?? (supersedeEvent === null ? "pending" : "superseded");

  return {
    request,
    status,
    terminalEvent,
    blocksReceiverDone: request.required && status === "pending",
    blocksSenderDone: request.required && (status === "pending" || status === "blocked")
  };
}

async function readRequestFiles(requestsDir: string): Promise<RequiredRequest[]> {
  const files = await readYamlFiles(requestsDir);
  return await Promise.all(
    files.map(async (file) =>
      parseYamlWithSchema(RequiredRequestSchema, await readFile(file, "utf8"))
    )
  );
}

async function readEventFiles(eventsDir: string): Promise<AgentQEvent[]> {
  const files = await readYamlFiles(eventsDir);
  return await Promise.all(
    files.map(async (file) => parseYamlWithSchema(EventSchema, await readFile(file, "utf8")))
  );
}

async function readYamlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => path.join(dir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}
