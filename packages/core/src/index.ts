export const AGENTQ_NAME = "AgentQ";
export const AGENTQ_TAGLINE = "The handshake between coding agents.";

export const AGENTQ_POSITIONING =
  "Explicit ownership claims and durable questions for agents sharing one workspace.";

export interface AgentQSurface {
  readonly name: typeof AGENTQ_NAME;
  readonly tagline: typeof AGENTQ_TAGLINE;
  readonly positioning: typeof AGENTQ_POSITIONING;
}

export function describeAgentQ(): AgentQSurface {
  return {
    name: AGENTQ_NAME,
    tagline: AGENTQ_TAGLINE,
    positioning: AGENTQ_POSITIONING
  };
}

export { normalizeAdapterId } from "./adapters/contract.js";
export type {
  RegistrationResult,
  RegistrationUnavailableReason
} from "./adapters/contract.js";
export type {
  AdapterId,
  ActorId,
  ClaimSnapshot,
  Presence,
  QuestionRecord,
  QuestionStatus,
  WorkspaceHash
} from "./domain/types.js";
export { createWorkspaceStoreLayout } from "./store/layout.js";
export type { WorkspaceStoreLayout } from "./store/layout.js";
export {
  ensureWorkspaceStore,
  resolveWorkspaceStore
} from "./store/workspaceStore.js";
export type {
  WorkspaceStore,
  WorkspaceStoreOptions
} from "./store/workspaceStore.js";
export {
  registerAdapterSession,
  resolveAdapterSessionActorId
} from "./store/sessionBinding.js";
export type {
  AdapterSessionLookup,
  AdapterSessionRegistrationInput,
  OpaqueSessionBinding
} from "./store/sessionBinding.js";
export { clearClaims, setClaims } from "./claims/claims.js";
export { findOwners } from "./routing/owners.js";
export type { OwnerMatch, OwnerOverlap } from "./routing/owners.js";
export {
  answerQuestion,
  cancelQuestion,
  createQuestion,
  declineQuestionAsNotMine,
  listInbox,
  QuestionRoutingError
} from "./questions/questions.js";
export type {
  CreateQuestionInput,
  QuestionRoutingErrorCode
} from "./questions/questions.js";
