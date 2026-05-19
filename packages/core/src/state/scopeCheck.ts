import { readFile } from "node:fs/promises";
import { parseYamlWithSchema, PresenceSchema } from "../domain/schema.js";
import type { Presence } from "../domain/types.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";

export type ScopeWeaknessKind =
  | "missing_presence"
  | "broad_path"
  | "generic_responsibility";

export interface ScopeWeakness {
  readonly kind: ScopeWeaknessKind;
  readonly detail: string;
}

export interface ScopeCheckResult {
  readonly ok: boolean;
  readonly actorId: string;
  readonly weaknesses: readonly ScopeWeakness[];
}

export async function runScopeCheck(
  store: WorkspaceStore,
  actorId: string
): Promise<ScopeCheckResult> {
  try {
    const presence = parseYamlWithSchema(
      PresenceSchema,
      await readFile(store.layout.actorPresencePath(actorId), "utf8")
    );
    return evaluateScopeCheck(actorId, presence);
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        ok: false,
        actorId,
        weaknesses: [{ kind: "missing_presence", detail: "actor presence is not registered" }]
      };
    }

    throw error;
  }
}

export function evaluateScopeCheck(
  actorId: string,
  presence: Presence
): ScopeCheckResult {
  const weaknesses = actorScopeWeaknesses(presence);
  return {
    ok: weaknesses.length === 0,
    actorId,
    weaknesses
  };
}

export function actorScopeWeaknesses(presence: Presence): ScopeWeakness[] {
  const weaknesses: ScopeWeakness[] = [];

  for (const activePath of presence.activePaths) {
    if (isBroadPresencePath(activePath)) {
      weaknesses.push({ kind: "broad_path", detail: activePath });
    }
  }

  for (const responsibility of presence.responsibilities) {
    if (isGenericResponsibility(responsibility)) {
      weaknesses.push({ kind: "generic_responsibility", detail: responsibility });
    }
  }

  return weaknesses;
}

export function planScopeContinuation(result: ScopeCheckResult): string {
  return [
    `AgentQ scope-check failed for ${result.actorId}.`,
    ...result.weaknesses.map((weakness) => `- ${weakness.kind}: ${weakness.detail}`),
    `Refresh this exact actor before claiming done: agentq enter --actor ${result.actorId} --paths <owned-path> --responsibility "<owned contract>"`
  ].join("\n");
}

function isBroadPresencePath(pathValue: string): boolean {
  return normalizePresencePath(pathValue) === ".";
}

function normalizePresencePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

function isGenericResponsibility(responsibility: string): boolean {
  return /(^| )(active tool scope|pre-tool scope|stop gate|session)( |$)/i.test(responsibility);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
