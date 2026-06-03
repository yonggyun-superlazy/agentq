import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendActiveWorkTouch,
  appendWorkEvidence,
  closeWork,
  ensureWorkspaceStore,
  readActiveWorkStack,
  readActiveWorkState,
  resolveWorkspaceStore,
  runWorkDoneCheck,
  startWork,
  writeAtomicYaml,
  writeOnceYaml
} from "../src/index.js";

describe("AgentQ work stack", () => {
  it("tracks active work, touched paths, evidence, and close state outside the repo", async () => {
    const store = await createStore();
    const actorId = "codex@workspace";

    const started = await startWork(store, {
      actorId,
      workId: "AW-1",
      title: "Move problem stack into AgentQ",
      paths: ["docs/work-notes/agentq.md"],
      now: "2026-05-18T00:00:00.000Z"
    });
    expect(started).toMatchObject({
      workId: "AW-1",
      status: "open",
      touchedPaths: ["docs/work-notes/agentq.md"]
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
      "docs/work-notes/agentq.md"
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
      spec: {
        objective: "Restore parent objective",
        denominator: ["parent pass criteria remains after child close"],
        nextOperation: "Continue parent after child pop"
      },
      paths: ["AgentQ"],
      now: "2026-05-18T00:00:00.000Z"
    });
    const child = await startWork(store, {
      actorId,
      workId: "AW-child",
      title: "Child frame",
      spec: {
        objective: "Verify child slice",
        slice: "child regression lane",
        passCriteria: ["child fixture passes"]
      },
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
      status: "open",
      spec: {
        objective: "Restore parent objective",
        nextOperation: "Continue parent after child pop"
      }
    });
    await expect(runWorkDoneCheck(store, actorId)).resolves.toMatchObject({
      ok: false,
      activeWork: expect.objectContaining({ workId: "AW-parent" })
    });
  });

  it("keeps legacy title/goal frames visible as obsolete stack frames", async () => {
    const store = await createStore();
    const actorId = "codex@workspace";

    await writeOnceYaml(store.layout.workEventPath("AW-legacy", "WE-legacy"), {
      kind: "work_started",
      id: "WE-legacy",
      workId: "AW-legacy",
      actorId,
      parentWorkId: null,
      title: "Title-only frame",
      goal: "Goal alias",
      paths: ["AgentQ/packages/core/src/work/workStack.ts"],
      at: "2026-05-18T00:00:00.000Z"
    });
    await writeAtomicYaml(store.layout.actorWorkPointerPath(actorId), {
      actorId,
      activeWorkId: "AW-legacy",
      updatedAt: "2026-05-18T00:00:00.000Z"
    });

    const active = await readActiveWorkState(store, actorId);
    expect(active).toMatchObject({
      workId: "AW-legacy",
      specStatus: "legacy-obsolete",
      spec: {
        objective: "Goal alias",
        slice: "Title-only frame"
      }
    });
    expect(active?.obsoleteReason).toContain("Legacy work_started event has no v2 frame spec");
  });

  it("reads the active work lineage from root to current", async () => {
    const store = await createStore();
    const actorId = "codex@workspace";

    await startWork(store, {
      actorId,
      workId: "AW-top",
      title: "Top request",
      paths: ["AgentQ"],
      now: "2026-05-18T00:00:00.000Z"
    });
    await startWork(store, {
      actorId,
      workId: "AW-parent",
      title: "Parent investigation",
      paths: ["AgentQ/packages/core"],
      now: "2026-05-18T00:01:00.000Z"
    });
    await startWork(store, {
      actorId,
      workId: "AW-current",
      title: "Current interruption",
      paths: ["AgentQ/packages/core/src/work/workStack.ts"],
      now: "2026-05-18T00:02:00.000Z"
    });

    await expect(readActiveWorkStack(store, actorId)).resolves.toMatchObject([
      { workId: "AW-top", title: "Top request" },
      { workId: "AW-parent", title: "Parent investigation" },
      { workId: "AW-current", title: "Current interruption" }
    ]);
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

  it("rejects pending-only close evidence until the final check is named", async () => {
    const store = await createStore();
    const actorId = "codex@workspace";

    await startWork(store, {
      actorId,
      workId: "AW-pending",
      title: "Pending close",
      paths: ["AgentQ"],
      now: "2026-05-18T00:00:00.000Z"
    });
    await appendWorkEvidence(store, {
      actorId,
      evidence: ["Verification checkpoint passed; summary inspection pending."],
      now: "2026-05-18T00:01:00.000Z"
    });

    await expect(
      closeWork(store, {
        actorId,
        summary: "Looks complete",
        evidence: [],
        now: "2026-05-18T00:02:00.000Z"
      })
    ).rejects.toThrow("pending evidence unresolved");

    const closed = await closeWork(store, {
      actorId,
      summary: "Closed after final verification",
      evidence: ["Final verification passed; no remaining summary inspection."],
      now: "2026-05-18T00:03:00.000Z"
    });
    expect(closed.status).toBe("closed");
  });

  it("can terminally close stale work as abandoned with evidence", async () => {
    const store = await createStore();
    const actorId = "codex@workspace";

    await startWork(store, {
      actorId,
      workId: "AW-abandoned",
      title: "Old stale frame",
      paths: ["AgentQ/packages/core/src/work/workStack.ts"],
      now: "2026-05-18T00:00:00.000Z"
    });

    const abandoned = await closeWork(store, {
      actorId,
      status: "abandoned",
      summary: "Superseded by later implementation frame",
      evidence: ["Current owner verified this stale frame has no remaining changes to land."],
      now: "2026-05-18T00:01:00.000Z"
    });

    expect(abandoned).toMatchObject({
      status: "abandoned",
      closeSummary: "Superseded by later implementation frame"
    });
    await expect(runWorkDoneCheck(store, actorId)).resolves.toEqual({ ok: true, actorId });
    await expect(
      appendWorkEvidence(store, {
        actorId,
        workId: "AW-abandoned",
        evidence: ["late evidence should fail"],
        now: "2026-05-18T00:02:00.000Z"
      })
    ).rejects.toThrow("already terminal");
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
