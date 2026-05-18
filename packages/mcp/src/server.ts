import { AGENTQ_NAME, AGENTQ_POSITIONING } from "@agentq/core";

export interface AgentQMcpInfo {
  readonly name: typeof AGENTQ_NAME;
  readonly purpose: typeof AGENTQ_POSITIONING;
}

export function createMcpInfo(): AgentQMcpInfo {
  return {
    name: AGENTQ_NAME,
    purpose: AGENTQ_POSITIONING
  };
}
