import path from "node:path";

const SAFE_ID_PATTERN = /^[A-Za-z0-9_.@-]+$/;

export interface WorkspaceStoreLayout {
  readonly root: string;
  readonly metadataPath: string;
  readonly actorsDir: string;
  readonly sessionsDir: string;
  readonly inboxDir: string;
  readonly questionsDir: string;
  readonly actorPresencePath: (actorId: string) => string;
  readonly actorClaimsPath: (actorId: string) => string;
  readonly sessionPath: (adapterSessionKey: string) => string;
  readonly inboxPointerPath: (actorId: string, questionId: string) => string;
  readonly questionDir: (questionId: string) => string;
  readonly questionPath: (questionId: string) => string;
  readonly questionTerminalPath: (questionId: string) => string;
}

export function createWorkspaceStoreLayout(root: string): WorkspaceStoreLayout {
  const actorsDir = path.join(root, "actors");
  const sessionsDir = path.join(root, "sessions");
  const inboxDir = path.join(root, "inbox");
  const questionsDir = path.join(root, "questions");

  return {
    root,
    metadataPath: path.join(root, "metadata.yaml"),
    actorsDir,
    sessionsDir,
    inboxDir,
    questionsDir,
    actorPresencePath: (actorId) =>
      path.join(actorsDir, safeSegment("actor id", actorId), "presence.yaml"),
    actorClaimsPath: (actorId) =>
      path.join(actorsDir, safeSegment("actor id", actorId), "claims.yaml"),
    sessionPath: (adapterSessionKey) =>
      path.join(sessionsDir, `${safeSegment("session key", adapterSessionKey)}.yaml`),
    inboxPointerPath: (actorId, questionId) =>
      path.join(
        inboxDir,
        safeSegment("actor id", actorId),
        `${safeSegment("question id", questionId)}.yaml`
      ),
    questionDir: (questionId) => path.join(questionsDir, safeSegment("question id", questionId)),
    questionPath: (questionId) =>
      path.join(questionsDir, safeSegment("question id", questionId), "question.yaml"),
    questionTerminalPath: (questionId) =>
      path.join(questionsDir, safeSegment("question id", questionId), "terminal.yaml")
  };
}

function safeSegment(label: string, value: string): string {
  if (!SAFE_ID_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(`AgentQ ${label} must be a safe identifier: ${value}`);
  }
  return value;
}
