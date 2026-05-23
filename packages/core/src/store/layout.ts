import path from "node:path";

const SAFE_ID_PATTERN = /^[A-Za-z0-9_.@-]+$/;

export interface WorkspaceStoreLayout {
  readonly root: string;
  readonly metadataPath: string;
  readonly actorsDir: string;
  readonly sessionsDir: string;
  readonly inboxDir: string;
  readonly messagesDir: string;
  readonly workDir: string;
  readonly diagnosticsDir: string;
  readonly diagnosticsRingPath: string;
  readonly workActorsDir: string;
  readonly workItemsDir: string;
  readonly actorPresencePath: (actorId: string) => string;
  readonly sessionPath: (adapterSessionKey: string) => string;
  readonly inboxPointerPath: (actorId: string, messageId: string) => string;
  readonly messageDir: (messageId: string) => string;
  readonly messagePath: (messageId: string) => string;
  readonly routingPath: (messageId: string) => string;
  readonly requestPath: (messageId: string, actorId: string) => string;
  readonly eventPath: (messageId: string, eventId: string) => string;
  readonly actorWorkPointerPath: (actorId: string) => string;
  readonly workItemDir: (workId: string) => string;
  readonly workEventPath: (workId: string, eventId: string) => string;
}

export function createWorkspaceStoreLayout(root: string): WorkspaceStoreLayout {
  const actorsDir = path.join(root, "actors");
  const sessionsDir = path.join(root, "sessions");
  const inboxDir = path.join(root, "inbox");
  const messagesDir = path.join(root, "messages");
  const workDir = path.join(root, "work");
  const diagnosticsDir = path.join(root, "diagnostics");
  const workActorsDir = path.join(workDir, "actors");
  const workItemsDir = path.join(workDir, "items");

  return {
    root,
    metadataPath: path.join(root, "metadata.yaml"),
    actorsDir,
    sessionsDir,
    inboxDir,
    messagesDir,
    workDir,
    diagnosticsDir,
    diagnosticsRingPath: path.join(diagnosticsDir, "ring.jsonl"),
    workActorsDir,
    workItemsDir,
    actorPresencePath: (actorId) => path.join(actorsDir, safeSegment("actor id", actorId), "presence.yaml"),
    sessionPath: (adapterSessionKey) => path.join(sessionsDir, `${safeSegment("session key", adapterSessionKey)}.yaml`),
    inboxPointerPath: (actorId, messageId) =>
      path.join(inboxDir, safeSegment("actor id", actorId), `${safeSegment("message id", messageId)}.yaml`),
    messageDir: (messageId) => path.join(messagesDir, safeSegment("message id", messageId)),
    messagePath: (messageId) => path.join(messagesDir, safeSegment("message id", messageId), "message.yaml"),
    routingPath: (messageId) => path.join(messagesDir, safeSegment("message id", messageId), "routing.yaml"),
    requestPath: (messageId, actorId) =>
      path.join(messagesDir, safeSegment("message id", messageId), "requests", `${safeSegment("actor id", actorId)}.yaml`),
    eventPath: (messageId, eventId) =>
      path.join(messagesDir, safeSegment("message id", messageId), "events", `${safeSegment("event id", eventId)}.yaml`),
    actorWorkPointerPath: (actorId) => path.join(workActorsDir, safeSegment("actor id", actorId), "active.yaml"),
    workItemDir: (workId) => path.join(workItemsDir, safeSegment("work id", workId)),
    workEventPath: (workId, eventId) =>
      path.join(workItemsDir, safeSegment("work id", workId), "events", `${safeSegment("work event id", eventId)}.yaml`)
  };
}

function safeSegment(label: string, value: string): string {
  if (!SAFE_ID_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(`AgentQ ${label} must be a safe identifier: ${value}`);
  }

  return value;
}
