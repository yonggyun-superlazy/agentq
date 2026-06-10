export interface InternalQueueMaintenanceInput {
  readonly summary: string;
  readonly body: readonly string[];
  readonly afterAction?: string;
}

// Envelope kept to three boilerplate lines on purpose: this block is injected
// into agent context on every matched hook event, so each extra line is a
// recurring per-event token cost (2026-06-11 envelope trim).
export function renderInternalQueueMaintenance(input: InternalQueueMaintenanceInput): string {
  return [
    "[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    `summary: ${input.summary}`,
    ...(input.afterAction === undefined ? [] : [`after-action: ${input.afterAction}`]),
    ...input.body,
    "Internal shared-work maintenance: answer the user's latest requested artifact first. Hide internal ids, command names, and queue/work labels from user text unless asked.",
    "[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]"
  ].join("\n");
}
