import { describe, expect, it } from "vitest";
import {
  normalizeAdapterId,
} from "../src/index.js";
import {
  ClaimSnapshotSchema,
  QuestionRecordSchema,
  parseYamlWithSchema,
  stringifyYaml
} from "../src/domain/schema.js";

describe("reduced AgentQ domain schema", () => {
  it("keeps adapter identity generic and normalized", () => {
    expect(normalizeAdapterId(" Vendor.Adapter-1 ")).toBe("vendor.adapter-1");
    expect(() => normalizeAdapterId("custom adapter")).toThrow(/adapter/i);
  });

  it("requires all three authoritative claim categories in persisted snapshots", () => {
    expect(
      ClaimSnapshotSchema.parse({ paths: ["src/**"], resources: [], contracts: [] })
    ).toEqual({ paths: ["src/**"], resources: [], contracts: [] });
    expect(() => ClaimSnapshotSchema.parse({ paths: ["src/**"] })).toThrow();
  });

  it.each(["pending", "not_mine", "cancelled"] as const)(
    "accepts %s without an answer",
    (status) => {
      expect(QuestionRecordSchema.parse(question(status)).status).toBe(status);
    }
  );

  it("requires answer text only for answered state", () => {
    expect(
      QuestionRecordSchema.parse({ ...question("answered"), answer: "Use the shared schema." })
    ).toMatchObject({ status: "answered", answer: "Use the shared schema." });
    expect(() => QuestionRecordSchema.parse(question("answered"))).toThrow(/answer/i);
    expect(() =>
      QuestionRecordSchema.parse({ ...question("pending"), answer: "too early" })
    ).toThrow(/answer/i);
  });

  it("round-trips the reduced record through stored YAML", () => {
    const record = question("pending");
    expect(parseYamlWithSchema(QuestionRecordSchema, stringifyYaml(record))).toEqual(record);
  });
});

function question(status: "pending" | "answered" | "not_mine" | "cancelled") {
  return {
    id: "question_schema_fixture",
    senderActorId: "actor_000000000000000000000001",
    recipientActorId: "actor_000000000000000000000002",
    question: "Who owns this file?",
    scope: { paths: ["src/**"], resources: [], contracts: [] },
    status,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}
