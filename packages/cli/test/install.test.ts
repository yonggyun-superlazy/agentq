import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/main.js";

describe("CLI install trust", () => {
  it("defaults install to dry-run and prints rollback details", async () => {
    const workspace = await createWorkspace();
    const result = await runCommand(["install"], runtime(workspace));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Mode: no files written");
    expect(result.stdout).toContain("Rollback: agentq uninstall --yes");
    expect(result.stdout).toContain(".codex/hooks.json");
    expect(result.stdout).toContain("hook codex session-start");
    expect(result.stdout).toContain("hook codex pre-tool");
    expect(result.stdout).not.toContain("hook codex stop");
    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("applies install and uninstall only with --yes", async () => {
    const workspace = await createWorkspace();

    await expect(runCommand(["install", "--yes"], runtime(workspace))).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Mode: files were updated")
    });
    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).resolves.toContain(
      "<!-- agentq:begin -->"
    );
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).resolves.toContain(
      "hook codex session-start"
    );
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).resolves.toContain(
      "hook codex pre-tool"
    );
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).resolves.not.toContain(
      "hook codex stop"
    );

    await expect(runCommand(["uninstall"], runtime(workspace))).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Mode: no files written")
    });
    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).resolves.toContain(
      "<!-- agentq:begin -->"
    );

    await expect(runCommand(["uninstall", "--yes"], runtime(workspace))).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("AgentQ uninstall")
    });
    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).resolves.not.toContain(
      "<!-- agentq:begin -->"
    );
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

function runtime(cwd: string) {
  return {
    cwd,
    env: { LOCALAPPDATA: path.join(cwd, "local-app-data") },
    now: () => "2026-05-18T00:00:00.000Z"
  };
}

async function createWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agentq-cli-install-"));
}
