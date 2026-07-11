import { createHash } from "node:crypto";
import { readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { normalizeAdapterId, type RegistrationResult } from "../adapters/contract.js";
import {
  AdapterIdSchema,
  ClaimSnapshotSchema,
  parseYamlWithSchema,
  PresenceSchema,
  SafeIdSchema
} from "../domain/schema.js";
import type { AdapterId, ClaimSnapshot, Presence } from "../domain/types.js";
import type { WorkspaceStore } from "./workspaceStore.js";
import { writeAtomicYaml } from "./writeOnce.js";

const OpaqueSessionBindingSchema = z
  .object({
    adapterId: AdapterIdSchema,
    nativeSessionId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    actorId: SafeIdSchema,
    updatedAt: z.string().min(1)
  })
  .strict();

export type OpaqueSessionBinding = z.infer<typeof OpaqueSessionBindingSchema>;

export interface AdapterSessionRegistrationInput {
  readonly adapterId: string;
  readonly nativeSessionId?: string;
  readonly cwd: string;
  readonly now: string;
}

export interface AdapterSessionLookup {
  readonly adapterId: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
}

export async function registerAdapterSession(
  store: WorkspaceStore,
  input: AdapterSessionRegistrationInput
): Promise<RegistrationResult> {
  const adapterId = normalizeAdapterId(input.adapterId);
  const nativeSessionId = input.nativeSessionId?.trim() ?? "";
  if (nativeSessionId.length === 0) {
    return { status: "unavailable", reason: "missing_native_session" };
  }

  let cwd: string;
  try {
    cwd = await canonicalize(input.cwd);
  } catch (error) {
    return unavailableStoreError(error);
  }
  if (cwd !== store.workspaceRoot) {
    return {
      status: "unavailable",
      reason: "workspace_mismatch",
      diagnostic: `session cwd does not match workspace root: ${cwd}`
    };
  }

  const actorId = deriveOpaqueActorId(adapterId, store.workspaceRoot, nativeSessionId);
  const sessionPath = store.layout.sessionPath(opaqueSessionKey(adapterId, nativeSessionId));
  let existing: OpaqueSessionBinding | null;
  try {
    existing = await readExistingOpaqueSessionBinding(sessionPath);
  } catch (error) {
    return unavailableStoreError(error);
  }
  if (
    existing !== null &&
    (existing.adapterId !== adapterId ||
      existing.nativeSessionId !== nativeSessionId ||
      existing.workspaceRoot !== store.workspaceRoot ||
      existing.actorId !== actorId)
  ) {
    return {
      status: "unavailable",
      reason: "store_error",
      diagnostic: `session binding mismatch at ${sessionPath}`
    };
  }

  const binding: OpaqueSessionBinding = {
    adapterId,
    nativeSessionId,
    workspaceRoot: store.workspaceRoot,
    actorId,
    updatedAt: input.now
  };
  const presence: Presence = {
    actorId,
    adapterId,
    workspaceRoot: store.workspaceRoot,
    lastSeen: input.now
  };
  const emptyClaims: ClaimSnapshot = { paths: [], resources: [], contracts: [] };

  try {
    PresenceSchema.parse(presence);
    ClaimSnapshotSchema.parse(emptyClaims);
    await writeAtomicYaml(store.layout.actorClaimsPath(actorId), emptyClaims);
    await writeAtomicYaml(store.layout.actorPresencePath(actorId), presence);
    // Binding is last so adapter lookup cannot resolve a partially written new actor.
    await writeAtomicYaml(sessionPath, binding);
    await Promise.all([
      readFile(store.layout.actorPresencePath(actorId), "utf8").then((source) =>
        parseYamlWithSchema(PresenceSchema, source)
      ),
      readFile(store.layout.actorClaimsPath(actorId), "utf8").then((source) =>
        parseYamlWithSchema(ClaimSnapshotSchema, source)
      ),
      readFile(sessionPath, "utf8").then((source) =>
        parseYamlWithSchema(OpaqueSessionBindingSchema, source)
      )
    ]);
  } catch (error) {
    if (existing === null) {
      await Promise.allSettled([
        rm(path.dirname(store.layout.actorPresencePath(actorId)), { recursive: true, force: true }),
        rm(sessionPath, { force: true })
      ]);
    }
    return unavailableStoreError(error);
  }

  return { status: "registered", actorId };
}

export async function resolveAdapterSessionActorId(
  store: WorkspaceStore,
  lookup: AdapterSessionLookup
): Promise<string> {
  const adapterId = normalizeAdapterId(lookup.adapterId);
  const nativeSessionId = lookup.nativeSessionId.trim();
  if (nativeSessionId.length === 0) {
    throw new Error("AgentQ native session id is required.");
  }
  const cwd = await canonicalize(lookup.cwd);
  if (cwd !== store.workspaceRoot) {
    throw new Error(`AgentQ adapter cwd does not match workspace root: ${cwd}`);
  }

  const sessionPath = store.layout.sessionPath(opaqueSessionKey(adapterId, nativeSessionId));
  const binding = parseYamlWithSchema(OpaqueSessionBindingSchema, await readFile(sessionPath, "utf8"));
  if (
    binding.adapterId !== adapterId ||
    binding.nativeSessionId !== nativeSessionId ||
    binding.workspaceRoot !== store.workspaceRoot
  ) {
    throw new Error(`AgentQ session binding mismatch at ${sessionPath}`);
  }
  await readActorPresence(store, binding.actorId);
  return binding.actorId;
}

export async function findOpaqueSessionBindingByActorId(
  store: WorkspaceStore,
  actorId: string
): Promise<OpaqueSessionBinding | null> {
  SafeIdSchema.parse(actorId);
  const entries = await readDirectory(store.layout.sessionsDir);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      continue;
    }
    const source = await readFile(path.join(store.layout.sessionsDir, entry.name), "utf8");
    const result = OpaqueSessionBindingSchema.safeParse(parse(source));
    if (
      result.success &&
      result.data.actorId === actorId &&
      result.data.workspaceRoot === store.workspaceRoot
    ) {
      return result.data;
    }
  }
  return null;
}

export async function readActorPresence(store: WorkspaceStore, actorId: string): Promise<Presence> {
  SafeIdSchema.parse(actorId);
  return parseYamlWithSchema(
    PresenceSchema,
    await readFile(store.layout.actorPresencePath(actorId), "utf8")
  );
}

export async function listActorPresences(store: WorkspaceStore): Promise<Presence[]> {
  const entries = await readDirectory(store.layout.actorsDir);
  const presences = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => await readActorPresence(store, entry.name))
  );
  return presences.sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
}

function deriveOpaqueActorId(
  adapterId: AdapterId,
  workspaceRoot: string,
  nativeSessionId: string
): string {
  const digest = createHash("sha256")
    .update(adapterId)
    .update("\0")
    .update(workspaceRoot)
    .update("\0")
    .update(nativeSessionId)
    .digest("hex");
  return `actor_${digest.slice(0, 24)}`;
}

function opaqueSessionKey(adapterId: AdapterId, nativeSessionId: string): string {
  const digest = createHash("sha256")
    .update(adapterId)
    .update("\0")
    .update(nativeSessionId)
    .digest("hex");
  return `session_${digest.slice(0, 32)}`;
}

async function readExistingOpaqueSessionBinding(
  sessionPath: string
): Promise<OpaqueSessionBinding | null> {
  try {
    return parseYamlWithSchema(OpaqueSessionBindingSchema, await readFile(sessionPath, "utf8"));
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function canonicalize(filePath: string): Promise<string> {
  return path.normalize(await realpath(path.resolve(filePath)));
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function unavailableStoreError(error: unknown): RegistrationResult {
  return {
    status: "unavailable",
    reason: "store_error",
    diagnostic: error instanceof Error ? error.message : String(error)
  };
}
