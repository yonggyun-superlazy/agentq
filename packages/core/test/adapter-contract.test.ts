import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceStore,
  normalizeAdapterId,
  registerAdapterSession,
  resolveWorkspaceStore,
  type WorkspaceStore
} from "../src/index.js";

describe("adapter contract", () => {
  it("normalizes valid opaque ids while keeping third-party namespaces distinct", () => {
    expect(normalizeAdapterId(" Vendor.One ")).toBe("vendor.one");
    expect(normalizeAdapterId("vendor-one")).not.toBe(normalizeAdapterId("vendor-two"));
  });

  it.each(["", "   ", "custom adapter", "../vendor", "vendor/tool"])(
    "rejects malformed adapter id %j instead of collapsing it to custom",
    (adapterId) => {
      expect(() => normalizeAdapterId(adapterId)).toThrow(/adapter/i);
    }
  );

  it("returns unavailable for missing native identity and writes no binding or actor", async () => {
    const store = await createStore("workspace");

    await expect(
      registerAdapterSession(store, {
        adapterId: "codex",
        nativeSessionId: "",
        cwd: store.workspaceRoot,
        now: "2026-07-11T00:00:00.000Z"
      })
    ).resolves.toEqual({
      status: "unavailable",
      reason: "missing_native_session"
    });

    await expect(readdir(store.layout.sessionsDir)).resolves.toEqual([]);
    await expect(readdir(store.layout.actorsDir)).resolves.toEqual([]);
  });

  it("returns unavailable for a workspace mismatch and writes nothing", async () => {
    const store = await createStore("workspace");
    const otherWorkspace = path.join(path.dirname(store.workspaceRoot), "other-workspace");
    await mkdir(otherWorkspace, { recursive: true });

    const result = await registerAdapterSession(store, {
      adapterId: "codex",
      nativeSessionId: "native-session",
      cwd: otherWorkspace,
      now: "2026-07-11T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "workspace_mismatch"
    });
    await expect(readdir(store.layout.sessionsDir)).resolves.toEqual([]);
    await expect(readdir(store.layout.actorsDir)).resolves.toEqual([]);
  });
});

async function createStore(name: string): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-adapter-"));
  const workspace = path.join(tempRoot, name);
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "linux",
    env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  return store;
}
