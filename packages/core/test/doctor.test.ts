import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMarkerInstall, ensureWorkspaceStore, resolveWorkspaceStore, runDoctor } from "../src/index.js";

describe("AgentQ doctor", () => {
  it("reports marker-only install as advisory, not active hook gate", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    await applyMarkerInstall(workspace);
    const store = await resolveWorkspaceStore(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });
    await ensureWorkspaceStore(store);

    const report = await runDoctor(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(report.summary).toBe("warn");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        level: "ok",
        name: "OS-local runtime store"
      })
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        level: "warn",
        name: "Codex hook gate",
        detail: expect.stringContaining("active stop gate is not claimed")
      })
    );
  });

  it("fails when repo-local runtime state or committed config exists", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, ".agentq"), { recursive: true });
    await writeFile(path.join(workspace, "agentq.config.yaml"), "legacy: true\n", "utf8");

    const report = await runDoctor(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(report.summary).toBe("fail");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        level: "fail",
        name: "repo-local runtime state"
      })
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        level: "fail",
        name: "committed project config"
      })
    );
  });

  it("fails when installed hook files are disabled by settings", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, ".claude"), { recursive: true });
    await writeFile(
      path.join(workspace, ".claude", "settings.json"),
      JSON.stringify({
        disableAllHooks: true,
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "agentq hook claude-code stop" }]
            }
          ]
        }
      }),
      "utf8"
    );

    const report = await runDoctor(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(report.summary).toBe("fail");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        level: "fail",
        name: "Claude Code hook gate",
        detail: expect.stringContaining("disableAllHooks is true")
      })
    );
  });

  it("warns when hook files contain only a partial AgentQ hook set", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(
      path.join(workspace, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "agentq hook codex stop" }]
            }
          ]
        }
      }),
      "utf8"
    );

    const report = await runDoctor(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        level: "warn",
        name: "Codex hook gate",
        detail: expect.stringContaining("partial AgentQ hook entries")
      })
    );
  });

  it("does not claim Copilot cloud cross-machine coordination", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });

    const report = await runDoctor(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "Copilot cloud scope",
        detail: expect.stringContaining("advisory")
      })
    );
  });

  it("explains Copilot prompt-mode repo hook opt-in", async () => {
    const tempRoot = await createTempRoot();
    const workspace = path.join(tempRoot, "workspace");
    await mkdir(workspace, { recursive: true });

    const report = await runDoctor(workspace, {
      platform: "linux",
      env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        level: "ok",
        name: "Copilot prompt-mode repo hooks",
        detail: expect.stringContaining("GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true")
      })
    );

    const optedIn = await runDoctor(workspace, {
      platform: "linux",
      env: {
        HOME: tempRoot,
        XDG_STATE_HOME: path.join(tempRoot, "state"),
        GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: "true"
      }
    });

    expect(optedIn.checks).toContainEqual(
      expect.objectContaining({
        level: "ok",
        name: "Copilot prompt-mode repo hooks",
        detail: expect.stringContaining("is set")
      })
    );
  });
});

async function createTempRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agentq-doctor-"));
}
