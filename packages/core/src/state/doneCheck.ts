import { foldMessageState, type FoldedMessageState, type FoldedRequest } from "./fold.js";
import { listMessageIdsFromStore, type WorkspaceStore } from "../store/workspaceStore.js";
import { renderInternalQueueMaintenance } from "../output/internalEnvelope.js";

export type BlockingKind =
  | "inbound_pending"
  | "outbound_pending"
  | "outbound_blocked_requires_follow_up";

export interface DoneCheckBlockingItem {
  readonly kind: BlockingKind;
  readonly messageId: string;
  readonly actorId: string;
  readonly summary: string;
}

export interface DoneCheckResult {
  readonly ok: boolean;
  readonly actorId: string;
  readonly blocking: readonly DoneCheckBlockingItem[];
}

export interface StopContinuationDecision {
  readonly decision: "allow" | "block";
  readonly reason: string;
  readonly loopGuard: "none" | "first-block" | "stop-hook-active";
}

export async function runDoneCheck(
  store: WorkspaceStore,
  actorId: string
): Promise<DoneCheckResult> {
  const messageIds = await listMessageIdsFromStore(store);
  const states = await Promise.all(messageIds.map(async (messageId) => foldMessageState(store, messageId)));
  return evaluateDoneCheck(actorId, states);
}

export function evaluateDoneCheck(
  actorId: string,
  states: readonly FoldedMessageState[]
): DoneCheckResult {
  const blocking = states.flatMap((state) => blockingItemsForState(actorId, state));

  return {
    ok: blocking.length === 0,
    actorId,
    blocking
  };
}

export function planStopContinuation(
  result: DoneCheckResult,
  stopHookActive: boolean
): StopContinuationDecision {
  if (result.ok) {
    return {
      decision: "allow",
      reason: "AgentQ done-check passed.",
      loopGuard: "none"
    };
  }

  if (stopHookActive) {
    // This stop attempt was already blocked once. Blocking again cannot make an
    // unresolved reply resolvable within the same turn — it may depend on
    // another actor — and harnesses force-override after repeated blocks
    // anyway (Claude Code caps consecutive stop-hook blocks). Allow the stop;
    // the queue state persists and the next turn re-surfaces it.
    return {
      decision: "allow",
      reason: "AgentQ done-check still failing, but this stop attempt was already blocked once; allowing stop to avoid a block loop.",
      loopGuard: "stop-hook-active"
    };
  }

  const reason = renderInternalQueueMaintenance({
    summary: "Shared-work completion check failed.",
    afterAction: "Resolve the required shared-work step, then resume the user's request.",
    body: [
      "Do not use this maintenance status as the user-facing answer.",
      "A required reply or follow-up still blocks completion.",
      ...result.blocking.map(
        (item) => `- ${blockingKindLabel(item.kind)}: ${item.summary}`
      ),
      ...result.blocking.flatMap((item) => doneCheckNextLines(item)),
      "Use the shared-work helper with the current actor id before final response."
    ]
  });

  return {
    decision: "block",
    reason,
    loopGuard: "first-block"
  };
}

function doneCheckNextLines(item: DoneCheckBlockingItem): string[] {
  const nextLine = "  next: use the shared-work helper with the current actor id";

  if (item.kind === "inbound_pending") {
    return [nextLine];
  }

  if (item.kind === "outbound_pending") {
    return [
      nextLine,
      `  note: wait for ${item.actorId} to respond, or continue only non-overlapping work.`
    ];
  }

  return [
    nextLine,
    `  note: the blocked reply needs follow-up or explicit acceptance.`
  ];
}

function blockingKindLabel(kind: BlockingKind): string {
  if (kind === "inbound_pending") {
    return "inbound required reply";
  }
  if (kind === "outbound_pending") {
    return "outbound required reply";
  }
  return "blocked reply follow-up";
}

function blockingItemsForState(
  actorId: string,
  state: FoldedMessageState
): DoneCheckBlockingItem[] {
  const inbound = state.requests
    .filter((request) => request.request.to === actorId && request.blocksReceiverDone)
    .map((request) => ({
      kind: "inbound_pending" as const,
      messageId: request.request.messageId,
      actorId: request.request.to,
      summary: state.message.summary
    }));

  if (state.message.createdBy !== actorId) {
    return inbound;
  }

  return [
    ...inbound,
    ...state.requests.flatMap((request) => outboundBlockingItem(actorId, state, request))
  ];
}

function outboundBlockingItem(
  actorId: string,
  state: FoldedMessageState,
  request: FoldedRequest
): DoneCheckBlockingItem[] {
  if (request.status === "pending" && request.blocksSenderDone) {
    return [
      {
        kind: "outbound_pending",
        messageId: request.request.messageId,
        actorId: request.request.to,
        summary: state.message.summary
      }
    ];
  }

  if (request.status !== "blocked") {
    return [];
  }

  if (hasSenderFollowUpOrAccept(actorId, request.request.to, request.request.messageId, state)) {
    return [];
  }

  return [
    {
      kind: "outbound_blocked_requires_follow_up",
      messageId: request.request.messageId,
      actorId: request.request.to,
      summary: state.message.summary
    }
  ];
}

function hasSenderFollowUpOrAccept(
  senderActorId: string,
  blockedActorId: string,
  messageId: string,
  state: FoldedMessageState
): boolean {
  return state.events.some(
    (event) =>
      (event.kind === "follow_up" || event.kind === "accept_blocked") &&
      event.messageId === messageId &&
      event.actorId === senderActorId &&
      event.blockedActorId === blockedActorId
  );
}
