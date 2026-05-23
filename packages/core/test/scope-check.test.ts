import { describe, expect, it } from "vitest";
import { evaluateScopeCheck, type Presence } from "../src/index.js";

describe("scope-check engine", () => {
  it("fails broad actor paths and generic hook responsibilities", () => {
    const result = evaluateScopeCheck("codex@workspace@session", presence({
      activePaths: ["."],
      responsibilities: ["codex active tool scope"]
    }));

    expect(result.ok).toBe(false);
    expect(result.weaknesses).toEqual([
      { kind: "broad_path", detail: "." },
      { kind: "generic_responsibility", detail: "codex active tool scope" }
    ]);
  });

  it("passes specific paths and ownership responsibilities", () => {
    const result = evaluateScopeCheck("codex@workspace@session", presence({
      activePaths: ["packages/core/src/state/scopeCheck.ts"],
      responsibilities: ["agent scope health owner"]
    }));

    expect(result).toMatchObject({
      ok: true,
      weaknesses: []
    });
  });

  it("allows broad path when a concrete resource is registered", () => {
    const result = evaluateScopeCheck("codex@workspace@session", presence({
      activePaths: ["."],
      activeResources: ["unity:ProjectDD/DDUnity"],
      responsibilities: ["DD Unity editor owner"]
    }));

    expect(result).toMatchObject({
      ok: true,
      weaknesses: []
    });
  });
});

function presence(
  overrides: Pick<Presence, "activePaths" | "responsibilities"> & Partial<Pick<Presence, "activeResources">>
): Presence {
  return {
    actorId: "codex@workspace@session",
    kind: "codex",
    handle: "codex",
    workspaceRoot: "/workspace",
    summary: overrides.responsibilities[0] ?? "scope",
    lastSeen: "2026-05-18T00:00:00.000Z",
    ...overrides
  };
}
