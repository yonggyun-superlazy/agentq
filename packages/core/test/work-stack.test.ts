import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendActiveWorkTouch,
  appendWorkEvidence,
  closeWork,
  ensureWorkspaceStore,
  readActiveWorkState,
  resolveWorkspaceStore,
  runWorkDoneCheck,
  startWork
} from "../src/index.js";

describe("AgentQ work stack", () => {
  it("tracks active work, touched paths, evidence, and close state outside the repo", async () => {
    const store = await createStore();
    const actorId = "codex@workspace";

    const started = await startWork(store, {
      actorId,
      workId: "AW-1",
      title: "Move problem stack into AgentQ",
      paths: ["wiki/problem-stacks/agentq.md"],
      now: "2026-05-18T00:00:00.000Z"
    });
    expect(started).toMatchObject({
      workId: "AW-1",
      status: "open",
      touchedPaths: ["wiki/problem-stacks/agentq.md"]
    });
    await expect(readFile(path.join(store.workspaceRoot, ".agentq"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    await appendActiveWorkTouch(store, {
      actorId,
      paths: ["AgentQ/packages/core/src/work/workStack.ts"],
      now: "2026-05-18T00:01:00.000Z"
    });
    await appendWorkEvidence(store, {
      actorId,
      evidence: ["core work-stack test captured touch/evidence flow"],
      now: "2026-05-18T00:02:00.000Z"
    });

    const closed = await closeWork(store, {
      actorId,
      summary: "Work stack core closed",
      evidence: [],
      now: "2026-05-18T00:03:00.000Z"
    });
    expect(closed).toMatchObject({
      status: "closed",
      closeSummary: "Work stack core closed",
      evidence: ["core work-stack test captured touch/evidence flow"]
    });
    expect(closed.touchedPaths).toEqual([
      "AgentQ/packages/core/src/work/workStack.ts",
      "wiki/problem-stacks/agentq.md"
    ]);
    await expect(runWorkDoneCheck(store, actorId)).resolves.toEqual({ ok: true, actorId });
  });

  it("pushes nested work and pops back to the parent after child close", async () => {
    const store = await createStore();
    const actorId = "codex@workspace";

    await startWork(store, {
      actorId,
      workId: "AW-parent",
      title: "Parent frame",
      paths: ["AgentQ"],
      now: "2026-05-18T00:00:00.000Z"
    });
    const child = await startWork(store, {
      actorId,
      workId: "AW-child",
      title: "Child frame",
      paths: ["AgentQ/packages/core"],
      now: "2026-05-18T00:01:00.000Z"
    });
    expect(child.parentWorkId).toBe("AW-parent");

    await closeWork(store, {
      actorId,
      summary: "Child closed",
      evidence: ["child test evidence"],
      now: "2026-05-18T00:02:00.000Z"
    });

    const active = await readActiveWorkState(store, actorId);
    expect(active).toMatchObject({
      workId: "AW-parent",
      status: "open"
    });
    await expect(runWorkDoneCheck(store, actorId)).resolves.toMatchObject({
      ok: false,
      activeWork: expect.objectContaining({ workId: "AW-parent" })
    });
  });

  it("requires observable evidence before closing active work", async () => {
    const store = await createStore();
    const actorId = "codex@workspace";

    await startWork(store, {
      actorId,
      workId: "AW-no-evidence",
      title: "No evidence",
      paths: ["AgentQ"],
      now: "2026-05-18T00:00:00.000Z"
    });

    await expect(
      closeWork(store, {
        actorId,
        summary: "Cannot close",
        evidence: [],
        now: "2026-05-18T00:01:00.000Z"
      })
    ).rejects.toThrow("requires evidence");
  });
});

async function createStore() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-work-stack-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "win32",
    env: { LOCALAPPDATA: path.join(tempRoot, "local-app-data") }
  });
  await ensureWorkspaceStore(store);
  return store;
}
