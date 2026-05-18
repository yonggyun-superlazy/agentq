import { describe, expect, it } from "vitest";
import { createMcpInfo } from "../src/server.js";

describe("MCP surface", () => {
  it("stays aligned with the coordination protocol positioning", () => {
    expect(createMcpInfo()).toEqual({
      name: "AgentQ",
      purpose: "Required-response queues and completion gates for agents sharing one workspace."
    });
  });
});
