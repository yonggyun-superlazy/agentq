import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceStore,
  foldMessageState,
  resolveWorkspaceStore,
  writeOnceText,
  writeOnceYaml,
  type ResponseStatus,
  type WorkspaceStore
} from "../src/index.js";

describe("state fold", () => {
  it("marks a request pending when no terminal response event exists", async () => {
    const store = await createStore();
    await writeMessageWithRequest(store, "AQ-1", "claude-code@workspace");

    const state = await foldMessageState(store, "AQ-1");

    expect(state.requests[0]).toMatchObject({
      status: "pending",
      blocksReceiverDone: true,
      blocksSenderDone: true
    });
  });

  it.each<ResponseStatus>(["resolved", "answered", "not_mine", "invalid"])(
    "treats %s as a nonblocking terminal response",
    async (status) => {
      const store = await createStore();
      await writeMessageWithRequest(store, "AQ-1", "claude-code@workspace");
      await writeResponseEvent(store, "AQ-1", "EV-1", "claude-code@workspace", status);

      const state = await foldMessageState(store, "AQ-1");

      expect(state.requests[0]).toMatchObject({
        status,
        blocksReceiverDone: false,
        blocksSenderDone: false
      });
    }
  );

  it("treats sender supersede events as nonblocking terminal evidence", async () => {
    const store = await createStore();
    await writeMessageWithRequest(store, "AQ-1", "claude-code@workspace");
    await writeOnceYaml(store.layout.eventPath("AQ-1", "EV-1"), {
      kind: "supersede",
      id: "EV-1",
      messageId: "AQ-1",
      actorId: "codex@workspace",
      targetActorId: "claude-code@workspace",
      evidence: ["sender canceled stale request"],
      at: "2026-05-18T00:00:00.000Z"
    });

    const state = await foldMessageState(store, "AQ-1");

    expect(state.requests[0]).toMatchObject({
      status: "superseded",
      blocksReceiverDone: false,
      blocksSenderDone: false
    });
  });

  it("treats blocked as terminal for the receiver but still blocking for the sender", async () => {
    const store = await createStore();
    await writeMessageWithRequest(store, "AQ-1", "claude-code@workspace");
    await writeResponseEvent(store, "AQ-1", "EV-1", "claude-code@workspace", "blocked");

    const state = await foldMessageState(store, "AQ-1");

    expect(state.requests[0]).toMatchObject({
      status: "blocked",
      blocksReceiverDone: false,
      blocksSenderDone: true
    });
  });

  it("keeps delivery attempts as evidence without closing the required request", async () => {
    const store = await createStore();
    await writeMessageWithRequest(store, "AQ-1", "claude-code@workspace");
    await writeOnceYaml(store.layout.eventPath("AQ-1", "EV-delivery"), {
      kind: "delivery_attempt",
      id: "EV-delivery",
      messageId: "AQ-1",
      actorId: "claude-code@workspace",
      status: "executed",
      adapter: "claude-code",
      sessionId: "claude-session",
      exitCode: 0,
      timedOut: false,
      evidence: ["AgentQ attempted delivery"],
      at: "2026-05-18T00:00:00.000Z"
    });

    const state = await foldMessageState(store, "AQ-1");

    expect(state.events).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({
      status: "pending",
      blocksReceiverDone: true,
      blocksSenderDone: true
    });
  });

  it("rejects events that are missing terminal evidence", async () => {
    const store = await createStore();
    await writeMessageWithRequest(store, "AQ-1", "claude-code@workspace");
    await writeOnceYaml(store.layout.eventPath("AQ-1", "EV-1"), {
      kind: "response",
      id: "EV-1",
      messageId: "AQ-1",
      actorId: "claude-code@workspace",
      status: "resolved",
      evidence: [],
      at: "2026-05-18T00:00:00.000Z"
    });

    await expect(foldMessageState(store, "AQ-1")).rejects.toThrow();
  });

  it("rejects corrupt event YAML as structural state error", async () => {
    const store = await createStore();
    await writeMessageWithRequest(store, "AQ-1", "claude-code@workspace");
    await writeOnceText(store.layout.eventPath("AQ-1", "EV-1"), "kind: [");

    await expect(foldMessageState(store, "AQ-1")).rejects.toThrow();
  });
});

async function createStore(): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-fold-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "linux",
    env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  return store;
}

async function writeMessageWithRequest(
  store: WorkspaceStore,
  messageId: string,
  actorId: string
): Promise<void> {
  await writeOnceYaml(store.layout.messagePath(messageId), {
    id: messageId,
    kind: "blocker",
    createdBy: "codex@workspace",
    summary: "Generated API client is stale",
    paths: ["packages/generated/api-client.ts"],
    contracts: [],
    passCriteria: ["generated client includes UserRecord"],
    observed: "api-client.ts was not regenerated",
    brokenContract: "generated client must reflect API schema"
  });
  await writeOnceYaml(store.layout.requestPath(messageId, actorId), {
    messageId,
    to: actorId,
    required: true,
    routingEvidence: [{ kind: "explicit", detail: `--to ${actorId}` }]
  });
}

async function writeResponseEvent(
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
    at: "2026-05-18T00:00:00.000Z"
  });
}
