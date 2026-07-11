import path from "node:path";
import { readFile } from "node:fs/promises";
import { ClaimSnapshotSchema, parseYamlWithSchema, SafeIdSchema } from "../domain/schema.js";
import type { ClaimSnapshot } from "../domain/types.js";
import { findOpaqueSessionBindingByActorId } from "../store/sessionBinding.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";
import { writeAtomicYaml } from "../store/writeOnce.js";

export async function setClaims(
  store: WorkspaceStore,
  actorId: string,
  snapshot: ClaimSnapshot
): Promise<ClaimSnapshot> {
  SafeIdSchema.parse(actorId);
  if ((await findOpaqueSessionBindingByActorId(store, actorId)) === null) {
    throw new Error(`AgentQ actor has no workspace session binding: ${actorId}`);
  }

  const normalized = normalizeClaimSnapshot(store, snapshot);
  await writeAtomicYaml(store.layout.actorClaimsPath(actorId), normalized);
  return normalized;
}

export async function clearClaims(
  store: WorkspaceStore,
  actorId: string
): Promise<ClaimSnapshot> {
  return await setClaims(store, actorId, { paths: [], resources: [], contracts: [] });
}

export async function readClaims(
  store: WorkspaceStore,
  actorId: string
): Promise<ClaimSnapshot> {
  SafeIdSchema.parse(actorId);
  return parseYamlWithSchema(
    ClaimSnapshotSchema,
    await readFile(store.layout.actorClaimsPath(actorId), "utf8")
  );
}

export function normalizeClaimSnapshot(
  store: WorkspaceStore,
  snapshot: ClaimSnapshot
): ClaimSnapshot {
  const partial = snapshot as Partial<ClaimSnapshot>;
  return ClaimSnapshotSchema.parse({
    paths: unique((partial.paths ?? []).map((value) => normalizeClaimPath(store, value))),
    resources: normalizeOpaqueIdentifiers(partial.resources ?? []),
    contracts: normalizeOpaqueIdentifiers(partial.contracts ?? [])
  });
}

export function claimPathsOverlap(
  store: WorkspaceStore,
  leftPattern: string,
  rightPattern: string
): boolean {
  const left = comparablePath(store, normalizeClaimPath(store, leftPattern));
  const right = comparablePath(store, normalizeClaimPath(store, rightPattern));
  return pathPatternCovers(left, right) || pathPatternCovers(right, left);
}

function normalizeClaimPath(store: WorkspaceStore, value: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (trimmed.length === 0) {
    throw new Error("AgentQ claim path may not be empty.");
  }

  const withSlashes = trimmed.replace(/\\/g, "/");
  const workspace = store.workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const pathModule = isWindowsAbsolute(withSlashes) || isWindowsAbsolute(workspace)
    ? path.win32
    : path.posix;
  const nativeValue = pathModule === path.win32 ? withSlashes.replace(/\//g, "\\") : withSlashes;
  const nativeWorkspace = pathModule === path.win32 ? workspace.replace(/\//g, "\\") : workspace;

  let relative = withSlashes;
  if (pathModule.isAbsolute(nativeValue)) {
    const candidate = pathModule.relative(nativeWorkspace, nativeValue).replace(/\\/g, "/");
    if (candidate === ".." || candidate.startsWith("../") || pathModule.isAbsolute(candidate)) {
      throw new Error(`AgentQ claim path is outside the workspace: ${value}`);
    }
    relative = candidate;
  }

  const normalized = path.posix
    .normalize(relative.replace(/^\.\/+/, ""))
    .replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.length === 0) {
    throw new Error(`AgentQ claim path is outside the workspace: ${value}`);
  }
  return normalized;
}

function normalizeOpaqueIdentifiers(values: readonly string[]): string[] {
  return unique(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function comparablePath(store: WorkspaceStore, value: string): string {
  return store.platform === "win32" ? value.toLowerCase() : value;
}

function pathPatternCovers(pattern: string, candidate: string): boolean {
  if (pattern === ".") {
    return true;
  }
  if (pattern === candidate) {
    return true;
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/");
  }
  return candidate.startsWith(`${pattern}/`);
}

function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith("//?/");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
