import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOrRefreshSessionBinding,
  createRoutedBlocker,
  ensureWorkspaceStore,
  NoRecipientError,
  resolveWorkspaceStore,
  runDoneCheck,
  runScopeCheck,
  type Message,
  type WorkspaceStore
} from "../src/index.js";

const NOW = "2026-05-18T00:00:10.000Z";
const STALE_AFTER_MS = 60_000;

describe("external environment blocking boundaries", () => {
  it("fails loudly when a Windows external process has no LOCALAPPDATA", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-external-missing-localappdata-"));
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });

    await expect(resolveWorkspaceStore(workspace, {
      platform: "win32",
      env: {}
    })).rejects.toThrow("LOCALAPPDATA");
  });

  it("treats broad bookkeeping sessions as scope repair, not a done-check blocker", async () => {
    const store = await createStore("bookkeeping", "linux");
    const actor = await enterActor(store, "codex", "external-bookkeeping", ["."], [
      "codex active tool scope"
    ]);

    await expect(runScopeCheck(store, actor.actorId)).resolves.toMatchObject({
      ok: false,
      weaknesses: [
        { kind: "broad_path", detail: "." },
        { kind: "generic_responsibility", detail: "codex active tool scope" }
      ]
    });
    await expect(runDoneCheck(store, actor.actorId)).resolves.toMatchObject({
      ok: true,
      blocking: []
    });
    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-bookkeeping", ["AgentQ/packages/core/src/index.ts"], []),
        threadActorIds: [actor.actorId],
        recentActorIds: [actor.actorId],
        now: NOW,
        staleAfterMs: STALE_AFTER_MS
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
  });

  it("ignores stale external actors even when recent and thread context mention them", async () => {
    const store = await createStore("stale-known-actor", "linux");
    const actor = await enterActor(store, "copilot-cli", "external-stale", ["AgentQ/packages/core/src/**"], [
      "AgentQ core owner"
    ]);

    await expect(runDoneCheck(store, actor.actorId)).resolves.toMatchObject({
      ok: true,
      blocking: []
    });
    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-stale-known", ["AgentQ/packages/core/src/index.ts"], []),
        threadActorIds: [actor.actorId],
        recentActorIds: [actor.actorId],
        now: "2026-05-18T00:02:00.000Z",
        staleAfterMs: 30_000
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
  });

  it("flags command-like external paths and keeps them out of implicit routing", async () => {
    const store = await createStore("noisy-path", "win32");
    const actor = await enterActor(store, "claude-code", "external-shell-path", [
      "AgentQ/README.md | external shell"
    ], ["AgentQ public docs"]);

    await expect(runScopeCheck(store, actor.actorId)).resolves.toMatchObject({
      ok: false,
      weaknesses: [{ kind: "noisy_path", detail: "AgentQ/README.md | external shell" }]
    });
    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-noisy", ["AgentQ/README.md"], []),
        now: NOW,
        staleAfterMs: STALE_AFTER_MS
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
  });

  it("does not route from observed paths alone", async () => {
    const store = await createStore("observed-only", "linux");
    await enterActor(store, "claude-code", "external-observer", ["."], [
      "external observer"
    ], [], ["AgentQ/README.md"]);

    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-observed-only", ["AgentQ/README.md"], []),
        now: NOW,
        staleAfterMs: STALE_AFTER_MS
      })
    ).rejects.toBeInstanceOf(NoRecipientError);
  });

  it("routes quoted absolute workspace paths from external shells", async () => {
    const store = await createStore("quoted-absolute", "linux");
    const docsPath = `"${path.join(store.workspaceRoot, "AgentQ", "docs")}"`;
    const actor = await enterActor(store, "codex", "external-quoted-absolute", [docsPath], [
      "AgentQ docs owner"
    ]);

    const plan = await createRoutedBlocker(store, {
      message: blocker("AQ-quoted-absolute", ["AgentQ/docs/focused-product-validation.md"], []),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS
    });

    expect(plan.recipients.map((recipient) => recipient.actorId)).toEqual([actor.actorId]);
    expect(plan.recipients[0]?.evidence).toContainEqual({
      kind: "path",
      detail: docsPath
    });
  });

  it("allows broad external actors only when a concrete resource matches", async () => {
    const store = await createStore("resource", "darwin");
    const actor = await enterActor(store, "codex", "external-resource", ["."], [
      "DD Unity editor owner"
    ], ["unity:External/DDUnity"]);

    await expect(runScopeCheck(store, actor.actorId)).resolves.toMatchObject({
      ok: true,
      weaknesses: []
    });
    await expect(
      createRoutedBlocker(store, {
        message: blocker("AQ-path-only", ["External/Assets/Main.unity"], []),
        now: NOW,
        staleAfterMs: STALE_AFTER_MS
      })
    ).rejects.toBeInstanceOf(NoRecipientError);

    const plan = await createRoutedBlocker(store, {
      message: question("AQ-resource", [], [], ["unity:External/DDUnity"]),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS
    });

    expect(plan.recipients.map((recipient) => recipient.actorId)).toEqual([actor.actorId]);
    expect(plan.recipients[0]?.evidence).toContainEqual({
      kind: "resource",
      detail: "unity:External/DDUnity"
    });
  });

  it("normalizes external resource case, slash style, and trailing slashes", async () => {
    const store = await createStore("resource-normalization", "win32");
    const actor = await enterActor(store, "claude-code", "external-resource-normalized", ["."], [
      "External setup watcher"
    ], ["Setup-Watcher:External\\DDSetup\\"]);

    const plan = await createRoutedBlocker(store, {
      message: question("AQ-resource-normalized", [], [], ["setup-watcher:external/DDSetup"]),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS
    });

    expect(plan.recipients.map((recipient) => recipient.actorId)).toEqual([actor.actorId]);
    expect(plan.recipients[0]?.evidence).toContainEqual({
      kind: "resource",
      detail: "Setup-Watcher:External\\DDSetup\\"
    });
  });
});

async function createStore(label: string, platform: NodeJS.Platform): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `agentq-external-${label}-`));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform,
    env: stateEnvFor(platform, tempRoot)
  });
  await ensureWorkspaceStore(store);
  return store;
}

function stateEnvFor(platform: NodeJS.Platform, tempRoot: string): NodeJS.ProcessEnv {
  if (platform === "win32") {
    return { LOCALAPPDATA: path.join(tempRoot, "local-app-data") };
  }

  if (platform === "darwin") {
    return { HOME: tempRoot };
  }

  return { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") };
}

async function enterActor(
  store: WorkspaceStore,
  adapter: "codex" | "claude-code" | "copilot-cli",
  sessionId: string,
  activePaths: readonly string[],
  responsibilities: readonly string[],
  activeResources: readonly string[] = [],
  observedPaths: readonly string[] = []
): Promise<{ actorId: string }> {
  return await createOrRefreshSessionBinding(store, {
    adapter,
    sessionId,
    cwd: store.workspaceRoot,
    activePaths,
    ...(observedPaths.length === 0 ? {} : { observedPaths }),
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
    summary: "External environment should not create a false implicit blocker",
    paths: [...paths],
    contracts: [...contracts],
    passCriteria: ["only a concrete responsible actor is routed"],
    observed: "external environment scope is broad or noisy",
    brokenContract: "implicit routing must ignore non-actionable external scope"
  };
}

function question(
  id: string,
  paths: readonly string[],
  contracts: readonly string[],
  resources: readonly string[]
): Message {
  return {
    id,
    kind: "question",
    createdBy: "codex@workspace",
    summary: "Concrete resource ownership can route from an external environment",
    paths: [...paths],
    resources: [...resources],
    contracts: [...contracts],
    passCriteria: ["resource owner answers"],
    question: "Who owns this concrete external resource?",
    expectedAnswer: "The actor currently holding the resource"
  };
}
