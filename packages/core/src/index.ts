export const AGENTQ_NAME = "AgentQ";
export const AGENTQ_TAGLINE = "The handshake between coding agents.";

export const AGENTQ_POSITIONING =
  "Required-response queues and completion gates for agents sharing one workspace.";

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

export * from "./domain/schema.js";
export * from "./domain/types.js";
export * from "./store/layout.js";
export * from "./store/workspaceStore.js";
export * from "./store/writeOnce.js";
export * from "./store/sessionBinding.js";
export * from "./state/fold.js";
export * from "./state/doneCheck.js";
export * from "./state/scopeCheck.js";
export * from "./routing/routeBlocker.js";
export * from "./work/schema.js";
export * from "./work/workStack.js";
export * from "./installer/markerBlock.js";
export * from "./installer/doctor.js";
export * from "./installer/hookConfig.js";
export * from "./hooks/hookHandler.js";
