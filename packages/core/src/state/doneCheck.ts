import { foldMessageState, type FoldedMessageState, type FoldedRequest } from "./fold.js";
import { listMessageIdsFromStore, type WorkspaceStore } from "../store/workspaceStore.js";

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

  const reason = [
    `AgentQ done-check failed for ${result.actorId}.`,
    ...result.blocking.map(
      (item) => `- ${item.kind}: ${item.messageId} for ${item.actorId} (${item.summary})`
    ),
    ...result.blocking.flatMap((item) => doneCheckNextLines(result.actorId, item)),
    stopHookActive
      ? "Stop hook is already active; resolve these exact required replies before trying to finish again."
      : "Resolve required replies before final response."
  ].join("\n");

  return {
    decision: "block",
    reason,
    loopGuard: stopHookActive ? "stop-hook-active" : "first-block"
  };
}

function doneCheckNextLines(actorId: string, item: DoneCheckBlockingItem): string[] {
  if (item.kind === "inbound_pending") {
    return [`  next: agentq inbox --actor ${actorId}`];
  }

  if (item.kind === "outbound_pending") {
    return [
      `  next: wait for ${item.actorId} to respond; rerun agentq done-check --actor ${actorId} to see answered evidence.`
    ];
  }

  return [
    `  next: agentq follow-up ${item.messageId} --actor ${actorId} --to ${item.actorId} --evidence "...", or accept with agentq accept-blocked ${item.messageId} --actor ${actorId} --to ${item.actorId} --evidence "..."`
  ];
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
