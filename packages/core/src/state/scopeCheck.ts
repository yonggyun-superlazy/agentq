import { readFile } from "node:fs/promises";
import { parseYamlWithSchema, PresenceSchema } from "../domain/schema.js";
import type { Presence } from "../domain/types.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";
import { isBroadPresencePath, isGenericResponsibility } from "./presenceClassification.js";

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
  const hasConcreteResource = (presence.activeResources ?? []).length > 0;

  for (const activePath of presence.activePaths) {
    if (isBroadPresencePath(activePath) && !hasConcreteResource) {
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
    `Run: agentq next --actor ${result.actorId}`,
    "It will print the exact scope refresh command for this actor."
  ].join("\n");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
