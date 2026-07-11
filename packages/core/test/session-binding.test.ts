import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceStore,
  registerAdapterSession,
  resolveAdapterSessionActorId,
  resolveWorkspaceStore,
  type WorkspaceStore
} from "../src/index.js";

describe("session-to-actor binding", () => {
  it("returns one opaque stable actor for the same adapter, workspace, and native session", async () => {
    const store = await createStore("workspace");
    const first = await register(store, "codex", "native-secret-session");
    const second = await register(store, "codex", "native-secret-session", "2026-07-11T00:01:00.000Z");

    expect(first).toEqual(second);
    expect(first).toMatch(/^actor_[0-9a-f]{24}$/);
    expect(first).not.toContain("native-secret-session");
    expect(first).not.toContain(path.basename(store.workspaceRoot));
    await expect(
      resolveAdapterSessionActorId(store, {
        adapterId: "codex",
        nativeSessionId: "native-secret-session",
        cwd: store.workspaceRoot
      })
    ).resolves.toBe(first);
  });

  it("keeps sessions in one workspace distinct", async () => {
    const store = await createStore("workspace");
    const first = await register(store, "codex", "session-one");
    const second = await register(store, "codex", "session-two");

    expect(first).not.toBe(second);
  });

  it("includes workspace and opaque adapter identity in actor derivation", async () => {
    const firstStore = await createStore("workspace-one");
    const secondStore = await createStore("workspace-two");
    const nativeSessionId = "same-native-id";
    const firstActor = await register(firstStore, "vendor-one", nativeSessionId);
    const secondWorkspaceActor = await register(secondStore, "vendor-one", nativeSessionId);
    const secondAdapterActor = await register(firstStore, "vendor-two", nativeSessionId);

    expect(new Set([firstActor, secondWorkspaceActor, secondAdapterActor]).size).toBe(3);
  });

  it("writes binding, routeable presence, and an empty SessionStart claim snapshot", async () => {
    const store = await createStore("workspace");
    const actorId = await register(store, "claude", "session-one");

    await expect(readFile(store.layout.actorPresencePath(actorId), "utf8")).resolves.toContain(
      "lastSeen:"
    );
    await expect(readFile(store.layout.actorClaimsPath(actorId), "utf8")).resolves.toContain(
      "paths: []"
    );
    await expect(readFile(store.layout.actorClaimsPath(actorId), "utf8")).resolves.toContain(
      "resources: []"
    );
    await expect(readFile(store.layout.actorClaimsPath(actorId), "utf8")).resolves.toContain(
      "contracts: []"
    );
  });
});

async function register(
  store: WorkspaceStore,
  adapterId: string,
  nativeSessionId: string,
  now = "2026-07-11T00:00:00.000Z"
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

async function createStore(name: string): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-session-"));
  const workspace = path.join(tempRoot, name);
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "linux",
    env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  return store;
}
