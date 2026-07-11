import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createQuestion,
  ensureWorkspaceStore,
  findOwners,
  registerAdapterSession,
  resolveAdapterSessionActorId,
  resolveWorkspaceStore,
  setClaims,
  type ClaimSnapshot,
  type WorkspaceStore
} from "../src/index.js";

describe("owner discovery", () => {
  it("excludes the requester and reports path, resource, and contract overlap", async () => {
    const store = await createStore("linux");
    const requester = await register(store, "requester");
    const pathOwner = await register(store, "path-owner", "vendor-one");
    const resourceOwner = await register(store, "resource-owner", "vendor-two");
    const contractOwner = await register(store, "contract-owner", "claude");
    await setClaims(store, requester, scope(["src/**"], ["resource:A"], ["Contract-A"]));
    await setClaims(store, pathOwner, scope(["packages/core/src/**"], [], []));
    await setClaims(store, resourceOwner, scope([], ["resource:A"], []));
    await setClaims(store, contractOwner, scope([], [], ["Contract-A"]));

    const matches = await findOwners(
      store,
      requester,
      scope(["packages/core/src/domain/schema.ts"], ["resource:A"], ["Contract-A"])
    );

    expect(matches.map((match) => match.actorId).sort()).toEqual(
      [pathOwner, resourceOwner, contractOwner].sort()
    );
    expect(matches.find((match) => match.actorId === pathOwner)?.overlaps).toContainEqual({
      kind: "path",
      claimed: "packages/core/src/**",
      queried: "packages/core/src/domain/schema.ts"
    });
    expect(matches.find((match) => match.actorId === resourceOwner)?.overlaps).toContainEqual({
      kind: "resource",
      claimed: "resource:A",
      queried: "resource:A"
    });
    expect(matches.find((match) => match.actorId === contractOwner)?.overlaps).toContainEqual({
      kind: "contract",
      claimed: "Contract-A",
      queried: "Contract-A"
    });
  });

  it("uses case-insensitive Windows path overlap and case-sensitive Linux overlap", async () => {
    const windowsStore = await createStore("win32");
    const windowsRequester = await register(windowsStore, "requester");
    const windowsOwner = await register(windowsStore, "owner");
    await setClaims(windowsStore, windowsOwner, scope(["SRC/**"], [], []));

    await expect(
      findOwners(windowsStore, windowsRequester, scope(["src/file.ts"], [], []))
    ).resolves.toHaveLength(1);

    const linuxStore = await createStore("linux");
    const linuxRequester = await register(linuxStore, "requester");
    const linuxOwner = await register(linuxStore, "owner");
    await setClaims(linuxStore, linuxOwner, scope(["SRC/**"], [], []));

    await expect(
      findOwners(linuxStore, linuxRequester, scope(["src/file.ts"], [], []))
    ).resolves.toEqual([]);
  });

  it("rejects stale and unbound owners", async () => {
    const store = await createStore("linux");
    const requester = await register(store, "requester");
    const staleOwner = await register(
      store,
      "stale-owner",
      "codex",
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    );
    const unboundOwner = await register(store, "unbound-owner");
    await setClaims(store, staleOwner, scope(["src/**"], [], []));
    await setClaims(store, unboundOwner, scope(["src/**"], [], []));
    for (const entry of await readdir(store.layout.sessionsDir)) {
      const source = await readFile(path.join(store.layout.sessionsDir, entry), "utf8");
      if (source.includes(unboundOwner)) {
        await rm(path.join(store.layout.sessionsDir, entry));
      }
    }

    await expect(
      findOwners(store, requester, scope(["src/file.ts"], [], []))
    ).resolves.toEqual([]);
  });

  it("keeps adapter and owner lookups read-only", async () => {
    const store = await createStore("linux");
    const requester = await register(store, "requester");
    const owner = await register(store, "owner");
    await setClaims(store, owner, scope(["src/**"], [], []));
    const claimsBefore = await readFile(store.layout.actorClaimsPath(owner), "utf8");
    const presenceBefore = await readFile(store.layout.actorPresencePath(owner), "utf8");

    await resolveAdapterSessionActorId(store, {
      adapterId: "codex",
      nativeSessionId: "owner",
      cwd: store.workspaceRoot
    });
    await findOwners(store, requester, scope(["src/file.ts"], [], []));

    await expect(readFile(store.layout.actorClaimsPath(owner), "utf8")).resolves.toBe(claimsBefore);
    await expect(readFile(store.layout.actorPresencePath(owner), "utf8")).resolves.toBe(
      presenceBefore
    );
  });
});

describe("question routing", () => {
  it("creates one pending question only for a routeable claim-overlapping recipient", async () => {
    const store = await createStore("linux");
    const sender = await register(store, "sender");
    const recipient = await register(store, "recipient");
    await setClaims(store, recipient, scope(["src/**"], [], []));

    const question = await createQuestion(store, {
      senderActorId: sender,
      recipientActorId: recipient,
      question: "Who is changing this file?",
      scope: scope(["src/file.ts"], [], [])
    });

    expect(question).toMatchObject({
      senderActorId: sender,
      recipientActorId: recipient,
      status: "pending"
    });
    expect(question.id).toMatch(/^question_[0-9a-f]{32}$/);
    await expect(readFile(store.layout.questionPath(question.id), "utf8")).resolves.toContain(
      "status: pending"
    );
  });

  it("rejects unsupported routing before writing", async () => {
    const store = await createStore("linux");
    const sender = await register(store, "sender");
    const recipient = await register(store, "recipient");
    await setClaims(store, recipient, scope(["docs/**"], [], []));

    await expect(
      createQuestion(store, {
        senderActorId: sender,
        recipientActorId: recipient,
        question: "Who is changing this file?",
        scope: scope(["src/file.ts"], [], [])
      })
    ).rejects.toMatchObject({ code: "unsupported_recipient" });
    await expect(readdir(store.layout.questionsDir)).resolves.toEqual([]);
  });

  it("rejects sender-equals-recipient and a stale recipient without writing", async () => {
    const store = await createStore("linux");
    const sender = await register(store, "sender");
    await setClaims(store, sender, scope(["src/**"], [], []));

    await expect(
      createQuestion(store, {
        senderActorId: sender,
        recipientActorId: sender,
        question: "Can I ask myself?",
        scope: scope(["src/file.ts"], [], [])
      })
    ).rejects.toMatchObject({ code: "self_recipient" });

    const staleRecipient = await register(
      store,
      "stale-recipient",
      "claude",
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    );
    await setClaims(store, staleRecipient, scope(["src/**"], [], []));
    await expect(
      createQuestion(store, {
        senderActorId: sender,
        recipientActorId: staleRecipient,
        question: "Are you still there?",
        scope: scope(["src/file.ts"], [], [])
      })
    ).rejects.toMatchObject({ code: "unsupported_recipient" });
    await expect(readdir(store.layout.questionsDir)).resolves.toEqual([]);
  });
});

function scope(
  paths: readonly string[],
  resources: readonly string[],
  contracts: readonly string[]
): ClaimSnapshot {
  return { paths, resources, contracts };
}

async function register(
  store: WorkspaceStore,
  nativeSessionId: string,
  adapterId = "codex",
  now = new Date().toISOString()
): Promise<string> {
  const result = await registerAdapterSession(store, {
    adapterId,
    nativeSessionId,
    cwd: store.workspaceRoot,
    now
  });
  if (result.status !== "registered") {
    throw new Error(`registration unavailable: ${result.reason}`);
  }
  return result.actorId;
}

async function createStore(platform: NodeJS.Platform): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-routing-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform,
    env:
      platform === "win32"
        ? { LOCALAPPDATA: path.join(tempRoot, "state") }
        : { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  return store;
}
