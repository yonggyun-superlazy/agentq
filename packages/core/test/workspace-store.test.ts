import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceStore,
  resolveWorkspaceStore
} from "../src/index.js";
import { writeAtomicYaml, writeOnceYaml } from "../src/store/writeOnce.js";

describe("OS-local workspace store", () => {
  it("maps one canonical workspace to one store and preserves selected platform", async () => {
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
    expect(first.platform).toBe("linux");
  });

  it("creates metadata outside the repository", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const store = await resolveWorkspaceStore(workspace, {
      platform: "win32",
      env: { LOCALAPPDATA: path.join(tempRoot, "state") }
    });

    await ensureWorkspaceStore(store);

    await expect(readFile(store.layout.metadataPath, "utf8")).resolves.toContain(store.workspaceHash);
    await expect(readFile(path.join(workspace, ".agentq"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("supports write-once records and atomic snapshot replacement", async () => {
    const tempRoot = await createTempRoot();
    const filePath = path.join(tempRoot, "state.yaml");

    await writeOnceYaml(filePath, { state: "first" });
    await expect(writeOnceYaml(filePath, { state: "second" })).rejects.toMatchObject({
      code: "EEXIST"
    });
    await writeAtomicYaml(filePath, { state: "second" });
    await expect(readFile(filePath, "utf8")).resolves.toContain("second");
  });

  it("rejects unsafe ids for question and claim paths", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const store = await resolveWorkspaceStore(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(() => store.layout.questionPath("../question")).toThrow(/safe identifier/);
    expect(() => store.layout.actorClaimsPath("actor/evil")).toThrow(/safe identifier/);
  });
});

async function createTempRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agentq-store-"));
}
