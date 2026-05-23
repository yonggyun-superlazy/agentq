import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AgentKindSchema,
  parseYamlWithSchema,
  PresenceSchema,
  SafeIdSchema
} from "../domain/schema.js";
import type { AgentKind, Presence } from "../domain/types.js";
import type { WorkspaceStore } from "./workspaceStore.js";
import { writeAtomicYaml } from "./writeOnce.js";

const SessionBindingSchema = z
  .object({
    adapter: AgentKindSchema,
    sessionId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    actorId: SafeIdSchema,
    updatedAt: z.string().min(1)
  })
  .strict();

export type SessionBinding = z.infer<typeof SessionBindingSchema>;

export interface SessionBindingInput {
  readonly adapter: AgentKind;
  readonly sessionId: string;
  readonly cwd: string;
  readonly handle?: string;
  readonly activePaths: readonly string[];
  readonly observedPaths?: readonly string[];
  readonly activeResources?: readonly string[];
  readonly responsibilities: readonly string[];
  readonly summary: string;
  readonly now: string;
}

export interface HookActorLookup {
  readonly adapter: AgentKind;
  readonly sessionId: string;
  readonly cwd: string;
}

export interface ActorPresenceRefreshInput {
  readonly actorId: string;
  readonly cwd: string;
  readonly activePaths: readonly string[];
  readonly observedPaths?: readonly string[];
  readonly activeResources?: readonly string[];
  readonly responsibilities: readonly string[];
  readonly summary?: string;
  readonly mergeActivePaths?: boolean;
  readonly mergeObservedPaths?: boolean;
  readonly mergeActiveResources?: boolean;
  readonly now: string;
}

export async function createOrRefreshSessionBinding(
  store: WorkspaceStore,
  input: SessionBindingInput
): Promise<SessionBinding> {
  const cwd = await canonicalize(input.cwd);
  if (cwd !== store.workspaceRoot) {
    throw new Error(`AgentQ session cwd does not match workspace root: ${cwd}`);
  }

  const sessionPath = store.layout.sessionPath(createAdapterSessionKey(input.adapter, input.sessionId));
  const existing = await readExistingSessionBinding(sessionPath);
  const actorId = existing?.actorId ?? deriveActorId(store, input);
  const binding: SessionBinding = {
    adapter: input.adapter,
    sessionId: input.sessionId,
    workspaceRoot: store.workspaceRoot,
    actorId,
    updatedAt: input.now
  };
  const presence: Presence = {
    actorId,
    kind: input.adapter,
    handle: input.handle ?? input.adapter,
    workspaceRoot: store.workspaceRoot,
    activePaths: [...input.activePaths],
    ...(input.observedPaths === undefined ? {} : { observedPaths: [...input.observedPaths] }),
    ...(input.activeResources === undefined || input.activeResources.length === 0
      ? {}
      : { activeResources: [...input.activeResources] }),
    responsibilities: [...input.responsibilities],
    summary: input.summary,
    lastSeen: input.now
  };

  PresenceSchema.parse(presence);
  await writeAtomicYaml(sessionPath, binding);
  await writeAtomicYaml(store.layout.actorPresencePath(actorId), presence);
  return binding;
}

export async function resolveHookActorId(
  store: WorkspaceStore,
  lookup: HookActorLookup
): Promise<string> {
  const cwd = await canonicalize(lookup.cwd);
  if (cwd !== store.workspaceRoot) {
    throw new Error(`AgentQ hook cwd does not match workspace root: ${cwd}`);
  }

  const sessionPath = store.layout.sessionPath(createAdapterSessionKey(lookup.adapter, lookup.sessionId));
  const binding = parseYamlWithSchema(
    SessionBindingSchema,
    await readFile(sessionPath, "utf8")
  );

  if (binding.workspaceRoot !== store.workspaceRoot) {
    throw new Error(`AgentQ session binding belongs to another workspace: ${sessionPath}`);
  }

  return binding.actorId;
}

export async function listSessionBindings(store: WorkspaceStore): Promise<SessionBinding[]> {
  let entries;
  try {
    entries = await readdir(store.layout.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }

  const bindings = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map(async (entry) =>
        parseYamlWithSchema(
          SessionBindingSchema,
          await readFile(path.join(store.layout.sessionsDir, entry.name), "utf8")
        )
      )
  );

  return bindings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function findSessionBindingByActorId(
  store: WorkspaceStore,
  actorId: string
): Promise<SessionBinding | null> {
  SafeIdSchema.parse(actorId);
  const bindings = await listSessionBindings(store);

  return bindings.find((binding) => binding.actorId === actorId) ?? null;
}

export async function refreshActorPresence(
  store: WorkspaceStore,
  input: ActorPresenceRefreshInput
): Promise<Presence> {
  SafeIdSchema.parse(input.actorId);
  const cwd = await canonicalize(input.cwd);
  if (cwd !== store.workspaceRoot) {
    throw new Error(`AgentQ actor cwd does not match workspace root: ${cwd}`);
  }

  const existing = parseYamlWithSchema(
    PresenceSchema,
    await readFile(store.layout.actorPresencePath(input.actorId), "utf8")
  );
  if (existing.workspaceRoot !== store.workspaceRoot) {
    throw new Error(`AgentQ actor belongs to another workspace: ${input.actorId}`);
  }

  const presence: Presence = {
    ...existing,
    activePaths: refreshedActivePaths(existing.activePaths, input.activePaths, input.mergeActivePaths === true),
    ...refreshedObservedPaths(existing.observedPaths, input.observedPaths, input.mergeObservedPaths === true),
    ...refreshedOptionalList(existing.activeResources, input.activeResources, input.mergeActiveResources === true, "activeResources", true),
    responsibilities: input.responsibilities.length > 0
      ? [...input.responsibilities]
      : existing.responsibilities,
    summary: input.summary ?? existing.summary,
    lastSeen: input.now
  };
  if (presence.activeResources !== undefined && presence.activeResources.length === 0) {
    delete presence.activeResources;
  }

  PresenceSchema.parse(presence);
  await writeAtomicYaml(store.layout.actorPresencePath(input.actorId), presence);
  return presence;
}

function refreshedActivePaths(
  existingPaths: readonly string[],
  inputPaths: readonly string[],
  mergeActivePaths: boolean
): string[] {
  if (inputPaths.length === 0) {
    return [...existingPaths];
  }

  if (!mergeActivePaths) {
    return [...inputPaths];
  }

  return [...new Set([...existingPaths, ...inputPaths])].slice(0, 8);
}

function refreshedObservedPaths(
  existingPaths: readonly string[] | undefined,
  inputPaths: readonly string[] | undefined,
  mergeObservedPaths: boolean
): { readonly observedPaths?: string[] } {
  if (inputPaths === undefined || inputPaths.length === 0) {
    return existingPaths === undefined ? {} : { observedPaths: [...existingPaths] };
  }

  if (!mergeObservedPaths) {
    return { observedPaths: [...inputPaths] };
  }

  return { observedPaths: [...new Set([...(existingPaths ?? []), ...inputPaths])].slice(0, 8) };
}

function refreshedOptionalList<Key extends string>(
  existingValues: readonly string[] | undefined,
  inputValues: readonly string[] | undefined,
  mergeValues: boolean,
  key: Key,
  clearOnEmpty = false
): { readonly [K in Key]?: string[] } {
  if (inputValues === undefined) {
    return existingValues === undefined ? {} : { [key]: [...existingValues] } as { readonly [K in Key]?: string[] };
  }

  if (inputValues.length === 0) {
    return clearOnEmpty
      ? { [key]: [] } as unknown as { readonly [K in Key]?: string[] }
      : existingValues === undefined ? {} : { [key]: [...existingValues] } as { readonly [K in Key]?: string[] };
  }

  if (!mergeValues) {
    return { [key]: [...inputValues] } as { readonly [K in Key]?: string[] };
  }

  return { [key]: [...new Set([...(existingValues ?? []), ...inputValues])].slice(0, 8) } as {
    readonly [K in Key]?: string[];
  };
}

export function createAdapterSessionKey(adapter: AgentKind, sessionId: string): string {
  return `${adapter}-${slugify(sessionId)}`;
}

export async function listActorPresences(store: WorkspaceStore): Promise<Presence[]> {
  const entries = await readdir(store.layout.actorsDir, { withFileTypes: true });
  const presences = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        parseYamlWithSchema(
          PresenceSchema,
          await readFile(store.layout.actorPresencePath(entry.name), "utf8")
        )
      )
  );

  return presences.sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
}

function deriveActorId(store: WorkspaceStore, input: SessionBindingInput): string {
  const workspaceName = slugify(path.basename(store.workspaceRoot) || "workspace");
  const session = slugify(input.sessionId);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        adapter: input.adapter,
        workspaceRoot: store.workspaceRoot,
        sessionId: input.sessionId
      })
    )
    .digest("hex")
    .slice(0, 6);

  return `${input.adapter}@${workspaceName}@${session}@${hash}`;
}

async function readExistingSessionBinding(sessionPath: string): Promise<SessionBinding | null> {
  try {
    return parseYamlWithSchema(SessionBindingSchema, await readFile(sessionPath, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

async function canonicalize(filePath: string): Promise<string> {
  return path.normalize(await realpath(path.resolve(filePath)));
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  return slug.length === 0 ? "session" : slug;
}
