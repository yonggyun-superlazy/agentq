import { describe, expect, it } from "vitest";
import {
  EventSchema,
  MessageSchema,
  parseYamlWithSchema,
  RequiredRequestSchema,
  stringifyYaml
} from "../src/index.js";

describe("AgentQ domain schema", () => {
  it("accepts a strong blocker with routing evidence and pass criteria", () => {
    const parsed = MessageSchema.parse({
      id: "AQ-1",
      kind: "blocker",
      createdBy: "codex@workspace",
      summary: "Generated dispatch is stale",
      paths: ["ProjectDD/DD.Shared/Generated/DDUnit.Dispatch.g.cs"],
      contracts: [],
      passCriteria: ["generated dispatch includes DDUnit"],
      observed: "DDUnit.Dispatch.g.cs was not regenerated",
      brokenContract: "generated dispatch must reflect unit schema"
    });

    expect(parsed.kind).toBe("blocker");
  });

  it("rejects weak blockers without a path or contract", () => {
    expect(() =>
      MessageSchema.parse({
        id: "AQ-1",
        kind: "blocker",
        createdBy: "codex@workspace",
        summary: "Something failed",
        paths: [],
        contracts: [],
        passCriteria: ["explain the failure"],
        observed: "failure",
        brokenContract: "unknown"
      })
    ).toThrow(/path or contract/);
  });

  it("rejects terminal responses without evidence", () => {
    expect(() =>
      EventSchema.parse({
        kind: "response",
        id: "EV-1",
        messageId: "AQ-1",
        actorId: "claude-code@workspace",
        status: "resolved",
        evidence: [],
        at: "2026-05-18T00:00:00.000Z"
      })
    ).toThrow();
  });

  it("rejects ids that cannot be used as store path segments", () => {
    expect(() =>
      MessageSchema.parse({
        id: "../AQ-1",
        kind: "blocker",
        createdBy: "codex@workspace",
        summary: "Unsafe id",
        paths: ["README.md"],
        contracts: [],
        passCriteria: ["safe ids only"],
        observed: "unsafe id",
        brokenContract: "ids must not escape the runtime store"
      })
    ).toThrow(/identifier/);

    expect(() =>
      EventSchema.parse({
        kind: "response",
        id: "EV/1",
        messageId: "AQ-1",
        actorId: "claude-code@workspace",
        status: "resolved",
        evidence: ["resolved"],
        at: "2026-05-18T00:00:00.000Z"
      })
    ).toThrow(/identifier/);

    expect(() =>
      MessageSchema.parse({
        id: "..",
        kind: "blocker",
        createdBy: "codex@workspace",
        summary: "Unsafe id",
        paths: ["README.md"],
        contracts: [],
        passCriteria: ["safe ids only"],
        observed: "unsafe id",
        brokenContract: "ids must not escape the runtime store"
      })
    ).toThrow(/identifier/);

    expect(() =>
      MessageSchema.parse({
        id: "AQ:1",
        kind: "blocker",
        createdBy: "codex@workspace",
        summary: "Unsafe id",
        paths: ["README.md"],
        contracts: [],
        passCriteria: ["safe ids only"],
        observed: "unsafe id",
        brokenContract: "ids must be portable path segments"
      })
    ).toThrow(/identifier/);
  });

  it("parses stored YAML through the same schemas", () => {
    const request = parseYamlWithSchema(
      RequiredRequestSchema,
      stringifyYaml({
        messageId: "AQ-1",
        to: "claude-code@workspace",
        required: true,
        routingEvidence: [{ kind: "explicit", detail: "--to claude-code@workspace" }]
      })
    );

    expect(request.to).toBe("claude-code@workspace");
  });
});
