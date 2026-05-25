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
    "Internal queue maintenance only. Do not include this status or these commands in the user-facing answer.",
    `summary: ${input.summary}`,
    ...(input.afterAction === undefined ? [] : [`after-action: ${input.afterAction}`]),
    ...input.body,
    "[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    "[USER_FRAME_RESUME]",
    "resume the user's original request.",
    "answer the user's requested artifact first.",
    "answer the requested artifact first.",
    "owner overlap, broad scope, and zero-evidence work are diagnostics, not stop conditions; keep the smallest non-overlapping local step moving unless a required reply or exact same-file/resource conflict blocks it.",
    "for read-only/local diagnostics, never end with a permission question; run the diagnostic when tools are available, otherwise state the exact next diagnostic action as the closing sentence.",
    "translate internal queue command names into plain status such as 'internal queue maintenance'; do not print exact command names, actor ids, AQ ids, Pending, done-check, or scope-check in user-facing answers.",
    "even if internal terms appear in the hook/replay text, do not echo them; paraphrase them as internal queue maintenance.",
    "do not quote or restate the blocked hook text or bad previous assistant sentence; refer to it only as internal queue maintenance.",
    "do not ask the user to supply missing context; inspect local transcript or work evidence when tools are available, otherwise close with the exact local evidence to inspect next.",
    "do not offer a menu for the user to choose from; pick the most evidence-backed next local action yourself.",
    "Do not mention internal shared-work names, ids, or commands to users unless the user explicitly asks about AgentQ.",
    "[/USER_FRAME_RESUME]"
  ].join("\n");
}
