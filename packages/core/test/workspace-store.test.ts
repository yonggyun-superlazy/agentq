import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceStore,
  listMessageIdsFromStore,
  resolveWorkspaceStore,
  writeOnceYaml
} from "../src/index.js";

describe("OS-local workspace store", () => {
  it("maps the same canonical workspace to the same OS-local store", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace with spaces");
    const stateRoot = path.join(tempRoot, "state");
    await mkdir(workspace, { recursive: true });

    const first = await resolveWorkspaceStore(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: stateRoot }
    });
    const second = await resolveWorkspaceStore(path.join(workspace, "."), {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: stateRoot }
    });

    expect(first.layout.root).toBe(second.layout.root);
    expect(first.layout.root).toContain(path.join(stateRoot, "agentq", "workspaces"));
  });

  it("keeps different workspace roots in different stores", async () => {
    const tempRoot = await createTempRoot();
    const firstWorkspace = path.join(tempRoot, "one");
    const secondWorkspace = path.join(tempRoot, "two");
    await mkdir(firstWorkspace, { recursive: true });
    await mkdir(secondWorkspace, { recursive: true });

    const first = await resolveWorkspaceStore(firstWorkspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });
    const second = await resolveWorkspaceStore(secondWorkspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(first.layout.root).not.toBe(second.layout.root);
  });

  it("creates metadata outside the repo and does not create a repo .agentq directory", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });

    const store = await resolveWorkspaceStore(workspace, {
      platform: "win32",
      env: { LOCALAPPDATA: path.join(tempRoot, "local-app-data") }
    });

    await ensureWorkspaceStore(store);

    await expect(readFile(store.layout.metadataPath, "utf8")).resolves.toContain(store.workspaceHash);
    await expect(readFile(path.join(workspace, ".agentq"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("enforces write-once files", async () => {
    const tempRoot = await createTempRoot();
    const filePath = path.join(tempRoot, "message.yaml");

    await writeOnceYaml(filePath, { id: "AQ-1" });
    await expect(writeOnceYaml(filePath, { id: "AQ-2" })).rejects.toMatchObject({
      code: "EEXIST"
    });
  });

  it("reconstructs message ids from message directories without inbox pointers", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });

    const store = await resolveWorkspaceStore(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });
    await ensureWorkspaceStore(store);
    await mkdir(store.layout.messageDir("AQ-2"), { recursive: true });
    await mkdir(store.layout.messageDir("AQ-1"), { recursive: true });

    await expect(listMessageIdsFromStore(store)).resolves.toEqual(["AQ-1", "AQ-2"]);
  });

  it("rejects unsafe runtime path identifiers before path join can escape the store", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });

    const store = await resolveWorkspaceStore(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(() => store.layout.messagePath("../AQ-1")).toThrow(/safe identifier/);
    expect(() => store.layout.messagePath("..")).toThrow(/safe identifier/);
    expect(() => store.layout.messagePath(".")).toThrow(/safe identifier/);
    expect(() => store.layout.messagePath("AQ:1")).toThrow(/safe identifier/);
    expect(() => store.layout.eventPath("AQ-1", "EV/1")).toThrow(/safe identifier/);
    expect(() => store.layout.actorWorkPointerPath("codex/evil")).toThrow(/safe identifier/);
  });
});

async function createTempRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agentq-"));
}
