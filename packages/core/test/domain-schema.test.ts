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
      summary: "Generated API client is stale",
      paths: ["packages/generated/api-client.ts"],
      contracts: [],
      passCriteria: ["generated client includes UserRecord"],
      observed: "api-client.ts was not regenerated",
      brokenContract: "generated client must reflect API schema"
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

  it("accepts a required question with expected-answer criteria", () => {
    const parsed = MessageSchema.parse({
      id: "AQ-question",
      kind: "question",
      createdBy: "codex@workspace",
      summary: "Status badge ownership",
      paths: ["packages/runtime/src/eventBus.ts"],
      contracts: [],
      passCriteria: [],
      question: "Should status badges read from event payload or derived view state?",
      expectedAnswer: "Answer the state source and owning system."
    });

    expect(parsed.kind).toBe("question");
  });

  it("rejects weak questions without routing context or answer criteria", () => {
    expect(() =>
      MessageSchema.parse({
        id: "AQ-question",
        kind: "question",
        createdBy: "codex@workspace",
        summary: "Unscoped question",
        paths: [],
        contracts: [],
        passCriteria: [],
        question: "Who should answer this?"
      })
    ).toThrow();
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
