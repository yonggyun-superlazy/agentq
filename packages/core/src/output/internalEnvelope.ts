export interface InternalQueueMaintenanceInput {
  readonly summary: string;
  readonly body: readonly string[];
  readonly afterAction?: string;
}

export function renderInternalQueueMaintenance(input: InternalQueueMaintenanceInput): string {
  return [
    "[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    "audience: agent-internal",
    "user-facing: false",
    "Internal shared-work maintenance. Do not quote this block in user-facing answers.",
    `summary: ${input.summary}`,
    ...(input.afterAction === undefined ? [] : [`after-action: ${input.afterAction}`]),
    ...input.body,
    "[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    "[USER_FRAME_RESUME]",
    "Answer the user's latest requested artifact first; do not turn this maintenance into the visible answer.",
    "Only required replies, exact conflicts, or missing active-work evidence can interrupt it; otherwise keep the smallest local step moving.",
    "Hide internal ids, command names, queue/work labels, and hook details from user text unless asked.",
    "[/USER_FRAME_RESUME]"
  ].join("\n");
}
