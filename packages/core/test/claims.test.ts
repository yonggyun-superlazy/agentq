import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearClaims,
  ensureWorkspaceStore,
  registerAdapterSession,
  resolveWorkspaceStore,
  setClaims,
  type ClaimSnapshot,
  type WorkspaceStore
} from "../src/index.js";
import { ClaimSnapshotSchema, parseYamlWithSchema } from "../src/domain/schema.js";

describe("authoritative claim snapshots", () => {
  it("replaces the full snapshot and treats omitted categories as empty", async () => {
    const store = await createStore();
    const actorId = await register(store, "session-one");
    await setClaims(store, actorId, {
      paths: ["packages/core/src/**"],
      resources: [" resource:workspace-a/setup "],
      contracts: [" protocol-schema "]
    });

    const replacement = await setClaims(
      store,
      actorId,
      { paths: [`${store.workspaceRoot}${path.sep}README.md`] } as ClaimSnapshot
    );

    expect(replacement).toEqual({
      paths: ["README.md"],
      resources: [],
      contracts: []
    });
    await expect(readClaims(store, actorId)).resolves.toEqual(replacement);
  });

  it("normalizes and deduplicates only explicit scope values", async () => {
    const store = await createStore();
    const actorId = await register(store, "session-one");

    await expect(
      setClaims(store, actorId, {
        paths: ["./src\\domain/**", "src/domain/**"],
        resources: [" resource:A ", "resource:A"],
        contracts: [" Contract-A ", "Contract-A"]
      })
    ).resolves.toEqual({
      paths: ["src/domain/**"],
      resources: ["resource:A"],
      contracts: ["Contract-A"]
    });
  });

  it("clears every category idempotently", async () => {
    const store = await createStore();
    const actorId = await register(store, "session-one");
    await setClaims(store, actorId, {
      paths: ["src/**"],
      resources: ["resource:A"],
      contracts: ["Contract-A"]
    });

    const first = await clearClaims(store, actorId);
    const second = await clearClaims(store, actorId);

    expect(first).toEqual({ paths: [], resources: [], contracts: [] });
    expect(second).toEqual(first);
    await expect(readClaims(store, actorId)).resolves.toEqual(first);
  });

  it("rejects an unbound actor without creating claim state", async () => {
    const store = await createStore();

    await expect(
      setClaims(store, "actor_000000000000000000000000", {
        paths: ["src/**"],
        resources: [],
        contracts: []
      })
    ).rejects.toThrow(/bound|binding/i);
    await expect(
      readFile(store.layout.actorClaimsPath("actor_000000000000000000000000"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not refresh presence and readers observe only whole old or new snapshots", async () => {
    const store = await createStore();
    const actorId = await register(store, "session-one", "2026-07-11T00:00:00.000Z");
    const presenceBefore = await readFile(store.layout.actorPresencePath(actorId), "utf8");
    const oldSnapshot = await setClaims(store, actorId, {
      paths: ["old/**"],
      resources: ["resource:old"],
      contracts: ["ContractOld"]
    });
    const newSnapshot = {
      paths: ["new/**"],
      resources: ["resource:new"],
      contracts: ["ContractNew"]
    } satisfies ClaimSnapshot;

    const write = setClaims(store, actorId, newSnapshot);
    const observed = await Promise.all(
      Array.from({ length: 40 }, async () => await readClaims(store, actorId))
    );
    await write;

    expect(observed.every((snapshot) => sameSnapshot(snapshot, oldSnapshot) || sameSnapshot(snapshot, newSnapshot))).toBe(true);
    await expect(readFile(store.layout.actorPresencePath(actorId), "utf8")).resolves.toBe(
      presenceBefore
    );
  });
});

async function register(
  store: WorkspaceStore,
  nativeSessionId: string,
  now = new Date().toISOString()
): Promise<string> {
  const result = await registerAdapterSession(store, {
    adapterId: "codex",
    nativeSessionId,
    cwd: store.workspaceRoot,
    now
  });
  if (result.status !== "registered") {
    throw new Error(`registration unavailable: ${result.reason}`);
  }
  return result.actorId;
}

async function readClaims(store: WorkspaceStore, actorId: string): Promise<ClaimSnapshot> {
  return parseYamlWithSchema(
    ClaimSnapshotSchema,
    await readFile(store.layout.actorClaimsPath(actorId), "utf8")
  );
}

function sameSnapshot(left: ClaimSnapshot, right: ClaimSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function createStore(): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-claims-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "linux",
    env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  return store;
}
