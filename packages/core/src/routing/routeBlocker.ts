import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import {
  MessageSchema,
  parseYamlWithSchema,
  PresenceSchema,
  RoutingEvidenceSchema
} from "../domain/schema.js";
import type { Message, Presence, RequiredRequest } from "../domain/types.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";
import { writeOnceYaml } from "../store/writeOnce.js";

export type RoutingEvidence = z.infer<typeof RoutingEvidenceSchema>;

export interface BlockerRouteInput {
  readonly message: Message;
  readonly explicitTo?: readonly string[];
  readonly threadActorIds?: readonly string[];
  readonly recentActorIds?: readonly string[];
  readonly now: string;
  readonly staleAfterMs: number;
}

export interface RecipientRoute {
  readonly actorId: string;
  readonly evidence: readonly RoutingEvidence[];
}

export interface BlockerRoutePlan {
  readonly message: Message;
  readonly recipients: readonly RecipientRoute[];
}

export type RequiredRequestRouteInput = BlockerRouteInput;
export type RequiredRequestRoutePlan = BlockerRoutePlan;

export class NoRecipientError extends Error {
  public constructor(messageId: string) {
    super(`AgentQ cannot route required request ${messageId}: no active responsible actor matched.`);
  }
}

export class UnknownRecipientError extends Error {
  public constructor(actorId: string) {
    super(`AgentQ cannot route required request: explicit recipient is not active: ${actorId}`);
  }
}

export async function planRequiredRequestRoutes(
  store: WorkspaceStore,
  input: RequiredRequestRouteInput
): Promise<RequiredRequestRoutePlan> {
  MessageSchema.parse(input.message);
  const activePresences = await readActivePresences(store, input.now, input.staleAfterMs);
  const routeMap = new Map<string, RoutingEvidence[]>();
  const explicitTo = input.explicitTo ?? [];

  validateExplicitRecipients(activePresences, explicitTo);
  addExplicitRoutes(routeMap, activePresences, explicitTo);
  if (explicitTo.length === 0) {
    addContractRoutes(routeMap, activePresences, input.message.contracts);
    addPathRoutes(routeMap, activePresences, input.message.paths);
    addKnownActorRoutes(routeMap, activePresences, input.threadActorIds ?? [], "thread");
    addKnownActorRoutes(routeMap, activePresences, input.recentActorIds ?? [], "recent");
    removeImplicitSelfRoute(routeMap, input.message.createdBy);
  }

  const recipients = [...routeMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([actorId, evidence]) => ({ actorId, evidence }));

  if (recipients.length === 0) {
    throw new NoRecipientError(input.message.id);
  }

  return {
    message: input.message,
    recipients
  };
}

function validateExplicitRecipients(
  presences: readonly Presence[],
  explicitTo: readonly string[]
): void {
  for (const actorId of explicitTo) {
    if (!presences.some((presence) => presence.actorId === actorId)) {
      throw new UnknownRecipientError(actorId);
    }
  }
}

export async function createRoutedBlocker(
  store: WorkspaceStore,
  input: BlockerRouteInput
): Promise<BlockerRoutePlan> {
  return await createRoutedRequest(store, input);
}

export async function planBlockerRoutes(
  store: WorkspaceStore,
  input: BlockerRouteInput
): Promise<BlockerRoutePlan> {
  return await planRequiredRequestRoutes(store, input);
}

export async function createRoutedRequest(
  store: WorkspaceStore,
  input: RequiredRequestRouteInput
): Promise<RequiredRequestRoutePlan> {
  const plan = await planRequiredRequestRoutes(store, input);
  const messageDir = store.layout.messageDir(input.message.id);
  await mkdir(path.join(messageDir, "requests"), { recursive: true });
  await mkdir(path.join(messageDir, "events"), { recursive: true });

  await writeOnceYaml(store.layout.messagePath(input.message.id), input.message);
  await writeOnceYaml(store.layout.routingPath(input.message.id), {
    messageId: input.message.id,
    recipients: plan.recipients
  });

  await Promise.all(
    plan.recipients.map(async (recipient) => {
      const request: RequiredRequest = {
        messageId: input.message.id,
        to: recipient.actorId,
        required: true,
        routingEvidence: [...recipient.evidence]
      };
      await writeOnceYaml(store.layout.requestPath(input.message.id, recipient.actorId), request);
      await writeOnceYaml(store.layout.inboxPointerPath(recipient.actorId, input.message.id), {
        messageId: input.message.id
      });
    })
  );

  return plan;
}

async function readActivePresences(
  store: WorkspaceStore,
  now: string,
  staleAfterMs: number
): Promise<Presence[]> {
  const actors = await readActorIds(store);
  const presences = await Promise.all(
    actors.map(async (actorId) =>
      parseYamlWithSchema(PresenceSchema, await readFile(store.layout.actorPresencePath(actorId), "utf8"))
    )
  );
  const nowMs = Date.parse(now);

  return presences.filter((presence) => nowMs - Date.parse(presence.lastSeen) <= staleAfterMs);
}

async function readActorIds(store: WorkspaceStore): Promise<string[]> {
  try {
    const entries = await readdir(store.layout.actorsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
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
}

function addExplicitRoutes(
  routeMap: Map<string, RoutingEvidence[]>,
  presences: readonly Presence[],
  explicitTo: readonly string[]
): void {
  for (const actorId of explicitTo) {
    if (presences.some((presence) => presence.actorId === actorId)) {
      addEvidence(routeMap, actorId, {
        kind: "explicit",
        detail: `explicit recipient ${actorId}`
      });
    }
  }
}

function addContractRoutes(
  routeMap: Map<string, RoutingEvidence[]>,
  presences: readonly Presence[],
  contracts: readonly string[]
): void {
  const normalizedContracts = new Set(contracts.map(normalize));
  for (const presence of presences) {
    for (const responsibility of presence.responsibilities) {
      if (normalizedContracts.has(normalize(responsibility))) {
        addEvidence(routeMap, presence.actorId, {
          kind: "contract",
          detail: responsibility
        });
      }
    }
  }
}

function addPathRoutes(
  routeMap: Map<string, RoutingEvidence[]>,
  presences: readonly Presence[],
  messagePaths: readonly string[]
): void {
  for (const presence of presences) {
    for (const activePath of presence.activePaths) {
      if (messagePaths.some((messagePath) => pathPatternOverlaps(activePath, messagePath))) {
        addEvidence(routeMap, presence.actorId, {
          kind: "path",
          detail: activePath
        });
      }
    }
  }
}

function addKnownActorRoutes(
  routeMap: Map<string, RoutingEvidence[]>,
  presences: readonly Presence[],
  actorIds: readonly string[],
  kind: "thread" | "recent"
): void {
  for (const actorId of actorIds) {
    if (presences.some((presence) => presence.actorId === actorId)) {
      addEvidence(routeMap, actorId, {
        kind,
        detail: actorId
      });
    }
  }
}

function addEvidence(
  routeMap: Map<string, RoutingEvidence[]>,
  actorId: string,
  evidence: RoutingEvidence
): void {
  const existing = routeMap.get(actorId) ?? [];
  if (!existing.some((item) => item.kind === evidence.kind && item.detail === evidence.detail)) {
    routeMap.set(actorId, [...existing, evidence]);
  }
}

function removeImplicitSelfRoute(
  routeMap: Map<string, RoutingEvidence[]>,
  senderActorId: string
): void {
  routeMap.delete(senderActorId);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function pathPatternOverlaps(activePattern: string, messagePath: string): boolean {
  const active = normalizePath(activePattern);
  const message = normalizePath(messagePath);

  if (active === ".") {
    return false;
  }

  if (active === message) {
    return true;
  }

  if (active.endsWith("/**")) {
    const prefix = active.slice(0, -3);
    return message === prefix || message.startsWith(`${prefix}/`);
  }

  if (active.endsWith("/*")) {
    const prefix = active.slice(0, -1);
    return message.startsWith(prefix) && !message.slice(prefix.length).includes("/");
  }

  return message.startsWith(`${active}/`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}
