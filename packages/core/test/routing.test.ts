import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOrRefreshSessionBinding,
  createRoutedBlocker,
  ensureWorkspaceStore,
  foldMessageState,
  NoRecipientError,
  resolveWorkspaceStore,
  type Message,
  type WorkspaceStore
} from "../src/index.js";

describe("blocker routing", () => {
  it("routes explicit recipients and writes requests only after a route exists", async () => {
    const store = await createStore();
    const actor = await enterActor(store, "codex", "session-1", ["README.md"], ["public docs"]);

    const plan = await createRoutedBlocker(store, {
      message: blocker("AQ-1", ["README.md"], []),
      explicitTo: [actor.actorId],
      now: "2026-05-18T00:00:10.000Z",
      staleAfterMs: 60_000
    });

    expect(plan.recipients).toHaveLength(1);
    expect(plan.recipients[0]?.actorId).toBe(actor.actorId);
    expect(plan.recipients[0]?.evidence).toContainEqual({
      kind: "explicit",
      detail: `explicit recipient ${actor.actorId}`
    });
    await expect(readFile(store.layout.requestPath("AQ-1", actor.actorId), "utf8")).resolves.toContain(
      actor.actorId
    );
  });

  it("fans out to every active actor matched by contract or path", async () => {
    const store = await createStore();
    const schemaActor = await enterActor(store, "codex", "session-1", ["packages/core/src/**"], [
      "protocol schema"
    ]);
    const docsActor = await enterActor(store, "claude-code", "session-2", ["README.md"], [
      "public docs"
    ]);

    const plan = await createRoutedBlocker(store, {
      message: blocker("AQ-1", ["README.md", "packages/core/src/domain/schema.ts"], [
        "protocol schema"
      ]),
      now: "2026-05-18T00:00:10.000Z",
      staleAfterMs: 60_000
    });

    expect(plan.recipients.map((recipient) => recipient.actorId).sort()).toEqual(
      [docsActor.actorId, schemaActor.actorId].sort()
    );
  });

  it("routes to actors matched by active resource occupancy", async () => {
    const store = await createStore();
    const setupActor = await enterActor(
      store,
      "claude-code",
      "session-setup",
      ["ProjectDD"],
      ["DD setup watcher"],
      ["setup-watcher:ProjectDD/DDSetup"]
    );

    const plan = await createRoutedBlocker(store, {
      message: question("AQ-resource", [], [], ["setup-watcher:ProjectDD/DDSetup"]),
      now: "2026-05-18T00:00:10.000Z",
      staleAfterMs: 60_000
    });

    expect(plan.recipients.map((recipient) => recipient.actorId)).toEqual([setupActor.actorId]);
    expect(plan.recipients[0]?.evidence).toContainEqual({
      kind: "resource",
      detail: "setup-watcher:ProjectDD/DDSetup"
    });
  });

  it("matches recursive path patterns on segment boundaries", async () => {
    const store = await createStore();
    await enterActor(store, "codex", "session-1", ["src/**"], ["source"]);

    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-1", ["src2/file.ts"], []),
        now: "2026-05-18T00:00:10.000Z",
        staleAfterMs: 60_000
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
  });

  it("does not route implicit blockers to broad path actors", async () => {
    const store = await createStore();
    const sender = await enterActor(store, "codex", "session-1", ["."], ["sender broad scope"]);

    await enterActor(store, "claude-code", "session-2", ["."], ["receiver broad scope"]);

    await expect(
      createRoutedBlocker(store, {
        message: {
          ...blocker("AQ-1", ["packages/service/package.json"], []),
          createdBy: sender.actorId
        },
        now: "2026-05-18T00:00:10.000Z",
        staleAfterMs: 60_000
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
  });

  it("does not route implicit questions to broad path actors", async () => {
    const store = await createStore();
    await enterActor(store, "claude-code", "session-2", ["."], ["receiver broad scope"]);

    await expect(
      createRoutedBlocker(store, {
        message: question("AQ-1", ["AGENTS.md"], ["agent-instructions-sync"]),
        now: "2026-05-18T00:00:10.000Z",
        staleAfterMs: 60_000
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
  });

  it("still routes explicit requests to broad actors", async () => {
    const store = await createStore();
    const receiver = await enterActor(store, "claude-code", "session-2", ["."], ["receiver broad scope"]);

    const plan = await createRoutedBlocker(store, {
      message: {
        ...blocker("AQ-1", ["packages/service/package.json"], []),
        createdBy: "codex@sender"
      },
      explicitTo: [receiver.actorId],
      now: "2026-05-18T00:00:10.000Z",
      staleAfterMs: 60_000
    });

    expect(plan.recipients.map((recipient) => recipient.actorId)).toEqual([receiver.actorId]);
    expect(plan.recipients[0]?.evidence).toContainEqual({
      kind: "explicit",
      detail: `explicit recipient ${receiver.actorId}`
    });
  });

  it("keeps route path case distinct by default", async () => {
    const store = await createStore();
    await enterActor(store, "codex", "session-1", ["SRC/**"], ["source"]);

    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-1", ["src/file.ts"], []),
        now: "2026-05-18T00:00:10.000Z",
        staleAfterMs: 60_000
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
  });

  it("routes workspace absolute paths and comma-separated legacy active path values", async () => {
    const store = await createStore();
    const readmePath = path.join(store.workspaceRoot, "AgentQ", "README.md");
    const docsPath = path.join(store.workspaceRoot, "AgentQ", "docs");
    const receiver = await enterActor(
      store,
      "claude-code",
      "session-absolute",
      [`${readmePath},${docsPath}`],
      ["AgentQ public docs"]
    );

    const readmePlan = await createRoutedBlocker(store, {
      message: blocker("AQ-absolute", [readmePath], []),
      now: "2026-05-18T00:00:10.000Z",
      staleAfterMs: 60_000
    });
    const docsPlan = await createRoutedBlocker(store, {
      message: blocker("AQ-docs", ["AgentQ/docs/focused-product-validation.md"], []),
      now: "2026-05-18T00:00:10.000Z",
      staleAfterMs: 60_000
    });

    expect(readmePlan.recipients.map((recipient) => recipient.actorId)).toEqual([receiver.actorId]);
    expect(docsPlan.recipients.map((recipient) => recipient.actorId)).toEqual([receiver.actorId]);
    expect(readmePlan.recipients[0]?.evidence).toContainEqual({ kind: "path", detail: readmePath });
    expect(docsPlan.recipients[0]?.evidence).toContainEqual({ kind: "path", detail: docsPath });
  });

  it("routes relative message paths when an absolute active path cannot be root-relativized", async () => {
    const store = await createStore();
    const docsPath = "D:/a/_temp/agentq-cli-absolute-owners/AgentQ/docs";
    const receiver = await enterActor(store, "claude-code", "session-absolute-suffix", [docsPath], [
      "AgentQ public docs"
    ]);

    const plan = await createRoutedBlocker(store, {
      message: blocker("AQ-absolute-suffix", ["AgentQ/docs/focused-product-validation.md"], []),
      now: "2026-05-18T00:00:10.000Z",
      staleAfterMs: 60_000
    });

    expect(plan.recipients.map((recipient) => recipient.actorId)).toEqual([receiver.actorId]);
    expect(plan.recipients[0]?.evidence).toContainEqual({ kind: "path", detail: docsPath });
  });

  it("excludes stale actors from new blockers but keeps existing requests blocking", async () => {
    const store = await createStore();
    const staleActor = await enterActor(store, "codex", "session-1", ["packages/core/src/**"], [
      "protocol schema"
    ]);
    await writePendingRequest(store, staleActor.actorId);

    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-2", ["packages/core/src/domain/schema.ts"], ["protocol schema"]),
        now: "2026-05-18T00:02:00.000Z",
        staleAfterMs: 30_000
      })
    ).rejects.toBeInstanceOf(NoRecipientError);

    const existingState = await foldMessageState(store, "AQ-1");
    expect(existingState.requests[0]).toMatchObject({
      status: "pending",
      blocksSenderDone: true
    });
  });

  it("routes by thread and recent actor ids when those actors are active", async () => {
    const store = await createStore();
    const threadActor = await enterActor(store, "codex", "session-1", ["packages/core/src/**"], [
      "protocol schema"
    ]);
    const recentActor = await enterActor(store, "copilot-cli", "session-2", [".github/**"], [
      "copilot hooks"
    ]);

    const plan = await createRoutedBlocker(store, {
      message: blocker("AQ-1", ["docs/notes.md"], []),
      threadActorIds: [threadActor.actorId],
      recentActorIds: [recentActor.actorId],
      now: "2026-05-18T00:00:10.000Z",
      staleAfterMs: 60_000
    });

    expect(plan.recipients.map((recipient) => recipient.actorId).sort()).toEqual(
      [threadActor.actorId, recentActor.actorId].sort()
    );
  });

  it("fails without writing message files when no recipient matches", async () => {
    const store = await createStore();

    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-1", ["README.md"], []),
        now: "2026-05-18T00:00:10.000Z",
        staleAfterMs: 60_000
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
    await expect(readFile(store.layout.messagePath("AQ-1"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

async function createStore(): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-routing-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "linux",
    env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  return store;
}

async function enterActor(
  store: WorkspaceStore,
  adapter: "codex" | "claude-code" | "copilot-cli",
  sessionId: string,
  activePaths: readonly string[],
  responsibilities: readonly string[],
  activeResources: readonly string[] = []
): Promise<{ actorId: string }> {
  return await createOrRefreshSessionBinding(store, {
    adapter,
    sessionId,
    cwd: store.workspaceRoot,
    activePaths,
    ...(activeResources.length === 0 ? {} : { activeResources }),
    responsibilities,
    summary: responsibilities[0] ?? "session",
    now: "2026-05-18T00:00:00.000Z"
  });
}

function blocker(id: string, paths: readonly string[], contracts: readonly string[]): Message {
  return {
    id,
    kind: "blocker",
    createdBy: "codex@workspace",
    summary: "A blocker needs a responsible actor",
    paths: [...paths],
    contracts: [...contracts],
    passCriteria: ["responsible actor responds"],
    observed: "blocker observed",
    brokenContract: "required handoff must be answered"
  };
}

function question(
  id: string,
  paths: readonly string[],
  contracts: readonly string[],
  resources: readonly string[] = []
): Message {
  return {
    id,
    kind: "question",
    createdBy: "codex@workspace",
    summary: "A question needs a responsible actor",
    paths: [...paths],
    ...(resources.length === 0 ? {} : { resources: [...resources] }),
    contracts: [...contracts],
    passCriteria: ["responsible actor answers"],
    question: "Who owns this instruction update?",
    expectedAnswer: "Owner and target instruction surface"
  };
}

async function writePendingRequest(store: WorkspaceStore, actorId: string): Promise<void> {
  await createRoutedBlocker(store, {
    message: blocker("AQ-1", ["packages/core/src/domain/schema.ts"], ["protocol schema"]),
    explicitTo: [actorId],
    now: "2026-05-18T00:00:01.000Z",
    staleAfterMs: 60_000
  });
}
