import { describe, expect, it } from "vitest";
import { describeAgentQ } from "../src/index.js";

describe("AgentQ positioning", () => {
  it("anchors the product as a coding-agent handshake", () => {
    expect(describeAgentQ()).toEqual({
      name: "AgentQ",
      tagline: "The handshake between coding agents.",
      positioning: "Required-response queues and completion gates for agents sharing one workspace."
    });
  });
});
