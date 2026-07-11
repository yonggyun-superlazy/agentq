import { describe, expect, it } from "vitest";
import { describeAgentQ } from "../src/index.js";

describe("AgentQ positioning", () => {
  it("describes the reduced ownership and durable-question core", () => {
    expect(describeAgentQ()).toEqual({
      name: "AgentQ",
      tagline: "The handshake between coding agents.",
      positioning: "Explicit ownership claims and durable questions for agents sharing one workspace."
    });
  });
});
