import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOrRefreshSessionBinding,
  ensureWorkspaceStore,
  resolveHookActorId,
  resolveWorkspaceStore,
  resolveWrapperActorId,
  type WorkspaceStore
} from "../src/index.js";

describe("session-to-actor binding", () => {
  it("creates a session binding and resolves actor id without AGENTQ_ACTOR", async () => {
    const store = await createStore("workspace");
    const binding = await createOrRefreshSessionBinding(store, {
      adapter: "codex",
      sessionId: "session-1",
      cwd: store.workspaceRoot,
      activePaths: ["packages/core/src/**"],
      responsibilities: ["protocol schema"],
      summary: "schema work",
      now: "2026-05-18T00:00:00.000Z"
    });

    await expect(
      resolveHookActorId(store, {
        adapter: "codex",
        sessionId: "session-1",
        cwd: store.workspaceRoot
      })
    ).resolves.toBe(binding.actorId);
  });

  it("refreshes an existing session without changing actor id", async () => {
    const store = await createStore("workspace");
    const first = await createOrRefreshSessionBinding(store, {
      adapter: "claude-code",
      sessionId: "session-1",
      cwd: store.workspaceRoot,
      activePaths: ["README.md"],
      responsibilities: ["public docs"],
      summary: "docs work",
      now: "2026-05-18T00:00:00.000Z"
    });
    const second = await createOrRefreshSessionBinding(store, {
      adapter: "claude-code",
      sessionId: "session-1",
      cwd: store.workspaceRoot,
      activePaths: ["README.md"],
      responsibilities: ["public docs"],
      summary: "docs work updated",
      now: "2026-05-18T00:01:00.000Z"
    });

    expect(second.actorId).toBe(first.actorId);
    await expect(readFile(store.layout.actorPresencePath(first.actorId), "utf8")).resolves.toContain(
      "docs work updated"
    );
  });

  it("keeps wrapper env actor id as a fast path only", () => {
    expect(resolveWrapperActorId({ AGENTQ_ACTOR: "codex@workspace@schema@123456" })).toBe(
      "codex@workspace@schema@123456"
    );
    expect(resolveWrapperActorId({})).toBeNull();
  });

  it("rejects a hook cwd from another workspace", async () => {
    const store = await createStore("workspace-one");
    const otherWorkspace = path.join(path.dirname(store.workspaceRoot), "workspace-two");
    await mkdir(otherWorkspace, { recursive: true });
    await createOrRefreshSessionBinding(store, {
      adapter: "copilot-cli",
      sessionId: "session-1",
      cwd: store.workspaceRoot,
      activePaths: [".github/**"],
      responsibilities: ["copilot hooks"],
      summary: "copilot work",
      now: "2026-05-18T00:00:00.000Z"
    });

    await expect(
      resolveHookActorId(store, {
        adapter: "copilot-cli",
        sessionId: "session-1",
        cwd: otherWorkspace
      })
    ).rejects.toThrow(/cwd/);
  });
});

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
