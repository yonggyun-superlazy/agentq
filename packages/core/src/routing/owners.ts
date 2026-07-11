import type { ClaimSnapshot } from "../domain/types.js";
import {
  claimPathsOverlap,
  normalizeClaimSnapshot,
  readClaims
} from "../claims/claims.js";
import {
  findOpaqueSessionBindingByActorId,
  listActorPresences
} from "../store/sessionBinding.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";

export const ROUTEABLE_PRESENCE_MAX_AGE_MS = 60 * 60 * 1000;

export interface OwnerOverlap {
  readonly kind: "path" | "resource" | "contract";
  readonly claimed: string;
  readonly queried: string;
}

export interface OwnerMatch {
  readonly actorId: string;
  readonly overlaps: readonly OwnerOverlap[];
}

export async function findOwners(
  store: WorkspaceStore,
  requesterActorId: string,
  scope: ClaimSnapshot
): Promise<readonly OwnerMatch[]> {
  const query = normalizeClaimSnapshot(store, scope);
  const now = Date.now();
  const matches: OwnerMatch[] = [];

  // Transitional routeability only: this coarse actor-wide timestamp is not a
  // lease, claim renewal, acquisition lock, or mutation gate. D-019 owns replacement.
  for (const presence of await listActorPresences(store)) {
    if (presence.actorId === requesterActorId || !isFresh(presence.lastSeen, now)) {
      continue;
    }
    if ((await findOpaqueSessionBindingByActorId(store, presence.actorId)) === null) {
      continue;
    }

    let claims: ClaimSnapshot;
    try {
      claims = await readClaims(store, presence.actorId);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        continue;
      }
      throw error;
    }
    const overlaps = findOverlaps(store, claims, query);
    if (overlaps.length > 0) {
      matches.push({ actorId: presence.actorId, overlaps });
    }
  }

  return matches.sort((left, right) => left.actorId.localeCompare(right.actorId));
}

function findOverlaps(
  store: WorkspaceStore,
  claims: ClaimSnapshot,
  query: ClaimSnapshot
): OwnerOverlap[] {
  const overlaps: OwnerOverlap[] = [];
  for (const claimed of claims.paths) {
    for (const queried of query.paths) {
      if (claimPathsOverlap(store, claimed, queried)) {
        overlaps.push({ kind: "path", claimed, queried });
      }
    }
  }
  addOpaqueOverlaps(overlaps, "resource", claims.resources, query.resources);
  addOpaqueOverlaps(overlaps, "contract", claims.contracts, query.contracts);
  return overlaps;
}

function addOpaqueOverlaps(
  overlaps: OwnerOverlap[],
  kind: "resource" | "contract",
  claimedValues: readonly string[],
  queriedValues: readonly string[]
): void {
  for (const claimed of claimedValues) {
    for (const queried of queriedValues) {
      if (claimed === queried) {
        overlaps.push({ kind, claimed, queried });
      }
    }
  }
}

function isFresh(lastSeen: string, now: number): boolean {
  const lastSeenMs = Date.parse(lastSeen);
  return Number.isFinite(lastSeenMs) && now - lastSeenMs <= ROUTEABLE_PRESENCE_MAX_AGE_MS;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
