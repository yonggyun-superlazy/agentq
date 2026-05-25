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
    "Resume the user's request and answer the requested artifact first.",
    "Resolve only required replies or exact same-file/resource conflicts before continuing; otherwise keep the smallest local step moving.",
    "For read-only diagnostics, run the next safe local read/test instead of ending with a permission question.",
    "In user-facing text, paraphrase this as shared-work maintenance and omit internal ids, command names, queue labels, and work-stack labels unless requested.",
    "[/USER_FRAME_RESUME]"
  ].join("\n");
}
