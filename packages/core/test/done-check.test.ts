import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceStore,
  planStopContinuation,
  resolveWorkspaceStore,
  runDoneCheck,
  writeOnceYaml,
  type Message,
  type ResponseStatus,
  type WorkspaceStore
} from "../src/index.js";

describe("done-check engine", () => {
  it("fails the receiver while an inbound required request is pending", async () => {
    const store = await createStore();
    await writePendingBlocker(store, "codex@workspace", "claude-code@workspace");

    await expect(runDoneCheck(store, "claude-code@workspace")).resolves.toMatchObject({
      ok: false,
      blocking: [{ kind: "inbound_pending", messageId: "AQ-1" }]
    });
  });

  it("fails the sender while an outbound required request is pending", async () => {
    const store = await createStore();
    await writePendingBlocker(store, "codex@workspace", "claude-code@workspace");

    await expect(runDoneCheck(store, "codex@workspace")).resolves.toMatchObject({
      ok: false,
      blocking: [{ kind: "outbound_pending", messageId: "AQ-1" }]
    });
  });

  it.each<ResponseStatus>(["resolved", "answered", "not_mine", "invalid"])(
    "passes both sides after %s terminal evidence",
    async (status) => {
      const store = await createStore();
      await writePendingBlocker(store, "codex@workspace", "claude-code@workspace");
      await writeResponse(store, "AQ-1", "EV-1", "claude-code@workspace", status);

      await expect(runDoneCheck(store, "claude-code@workspace")).resolves.toMatchObject({
        ok: true
      });
      await expect(runDoneCheck(store, "codex@workspace")).resolves.toMatchObject({
        ok: true
      });
    }
  );

  it("keeps sender blocked after a blocked response until follow-up evidence exists", async () => {
    const store = await createStore();
    await writePendingBlocker(store, "codex@workspace", "claude-code@workspace");
    await writeResponse(store, "AQ-1", "EV-1", "claude-code@workspace", "blocked");

    await expect(runDoneCheck(store, "claude-code@workspace")).resolves.toMatchObject({
      ok: true
    });
    await expect(runDoneCheck(store, "codex@workspace")).resolves.toMatchObject({
      ok: false,
      blocking: [{ kind: "outbound_blocked_requires_follow_up" }]
    });

    await writeOnceYaml(store.layout.eventPath("AQ-1", "EV-2"), {
      kind: "follow_up",
      id: "EV-2",
      messageId: "AQ-1",
      actorId: "codex@workspace",
      blockedActorId: "claude-code@workspace",
      evidence: ["reframed blocker with narrower pass criteria"],
      at: "2026-05-18T00:01:00.000Z"
    });

    await expect(runDoneCheck(store, "codex@workspace")).resolves.toMatchObject({
      ok: true
    });
  });

  it("allows sender to accept blocked evidence explicitly", async () => {
    const store = await createStore();
    await writePendingBlocker(store, "codex@workspace", "claude-code@workspace");
    await writeResponse(store, "AQ-1", "EV-1", "claude-code@workspace", "blocked");
    await writeOnceYaml(store.layout.eventPath("AQ-1", "EV-2"), {
      kind: "accept_blocked",
      id: "EV-2",
      messageId: "AQ-1",
      actorId: "codex@workspace",
      blockedActorId: "claude-code@workspace",
      evidence: ["external owner accepted"],
      at: "2026-05-18T00:01:00.000Z"
    });

    await expect(runDoneCheck(store, "codex@workspace")).resolves.toMatchObject({
      ok: true
    });
  });

  it("allows sender to supersede a pending outbound request with evidence", async () => {
    const store = await createStore();
    await writePendingBlocker(store, "codex@workspace", "claude-code@workspace");
    await writeOnceYaml(store.layout.eventPath("AQ-1", "EV-1"), {
      kind: "supersede",
      id: "EV-1",
      messageId: "AQ-1",
      actorId: "codex@workspace",
      targetActorId: "claude-code@workspace",
      evidence: ["stale propagation converted to audit record"],
      at: "2026-05-18T00:01:00.000Z"
    });

    await expect(runDoneCheck(store, "codex@workspace")).resolves.toMatchObject({
      ok: true
    });
    await expect(runDoneCheck(store, "claude-code@workspace")).resolves.toMatchObject({
      ok: true
    });
  });

  it("returns deterministic stop continuation policy for repeated stop hooks", async () => {
    const store = await createStore();
    await writePendingBlocker(store, "codex@workspace", "claude-code@workspace");
    const result = await runDoneCheck(store, "codex@workspace");

    expect(planStopContinuation(result, false)).toMatchObject({
      decision: "block",
      loopGuard: "first-block"
    });
    expect(planStopContinuation(result, true)).toMatchObject({
      decision: "block",
      loopGuard: "stop-hook-active",
      reason: expect.stringContaining("Stop hook is already active")
    });
  });
});

async function createStore(): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-done-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "linux",
    env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  return store;
}

async function writePendingBlocker(
  store: WorkspaceStore,
  senderActorId: string,
  receiverActorId: string
): Promise<void> {
  await writeOnceYaml(store.layout.messagePath("AQ-1"), blocker("AQ-1", senderActorId));
  await writeOnceYaml(store.layout.requestPath("AQ-1", receiverActorId), {
    messageId: "AQ-1",
    to: receiverActorId,
    required: true,
    routingEvidence: [{ kind: "explicit", detail: `explicit recipient ${receiverActorId}` }]
  });
}

function blocker(id: string, senderActorId: string): Message {
  return {
    id,
    kind: "blocker",
    createdBy: senderActorId,
    summary: "Receiver must answer before sender finishes",
    paths: ["README.md"],
    contracts: [],
    passCriteria: ["receiver provides terminal evidence"],
    observed: "handoff is unresolved",
    brokenContract: "required handoff must be answered"
  };
}

async function writeResponse(
  store: WorkspaceStore,
  messageId: string,
  eventId: string,
  actorId: string,
  status: ResponseStatus
): Promise<void> {
  await writeOnceYaml(store.layout.eventPath(messageId, eventId), {
    kind: "response",
    id: eventId,
    messageId,
    actorId,
    status,
    evidence: [`${status} evidence`],
    at: "2026-05-18T00:01:00.000Z"
  });
}
