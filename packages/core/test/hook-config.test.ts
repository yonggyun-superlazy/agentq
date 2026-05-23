import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyHookConfigInstall,
  applyHookConfigUninstall,
  planHookConfigInstall
} from "../src/index.js";

describe("AgentQ hook config installer", () => {
  it("merges AgentQ hooks without removing existing Codex and Claude hooks", async () => {
    const workspace = await createWorkspace();
    await writeJson(path.join(workspace, ".codex", "hooks.json"), {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "python existing-hook.py" }]
          }
        ]
      }
    });
    await writeJson(path.join(workspace, ".claude", "settings.json"), {
      enabledPlugins: {},
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "python existing-hook.py" }]
          }
        ]
      }
    });

    const plan = await applyHookConfigInstall(workspace);

    expect(plan.entries).toContainEqual(
      expect.objectContaining({ relativePath: ".codex/hooks.json", action: "update" })
    );
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).resolves.toContain(
      "python existing-hook.py"
    );
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).resolves.toContain(
      "agentq hook codex stop"
    );
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).resolves.toContain(
      "agentq hook codex pre-tool"
    );
    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).resolves.toContain(
      "\"matcher\": \"Read|Grep|Glob|LS|Bash|Edit|MultiEdit|Write\""
    );
    await expect(readFile(path.join(workspace, ".claude", "settings.json"), "utf8")).resolves.toContain(
      "agentq hook claude-code stop"
    );
    await expect(readFile(path.join(workspace, ".claude", "settings.json"), "utf8")).resolves.toContain(
      "\"matcher\": \"Read|Grep|Glob|LS|Bash|Edit|MultiEdit|Write\""
    );
    await expect(readFile(path.join(workspace, ".github", "hooks", "agentq.json"), "utf8")).resolves.toContain(
      "agentq hook copilot-cli pre-tool"
    );
  });

  it("dry-runs and uninstalls only AgentQ-owned hook entries", async () => {
    const workspace = await createWorkspace();

    await expect(planHookConfigInstall(workspace)).resolves.toMatchObject({
      entries: [
        expect.objectContaining({ action: "create" }),
        expect.objectContaining({ action: "create" }),
        expect.objectContaining({ action: "create" })
      ]
    });
    await expect(readFile(path.join(workspace, ".github", "hooks", "agentq.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    await applyHookConfigInstall(workspace);
    await applyHookConfigUninstall(workspace);

    await expect(readFile(path.join(workspace, ".codex", "hooks.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(path.join(workspace, ".github", "hooks", "agentq.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("preserves non-AgentQ hooks that share a nested hook group with AgentQ", async () => {
    const workspace = await createWorkspace();
    await applyHookConfigInstall(workspace);

    const claudeSettingsPath = path.join(workspace, ".claude", "settings.json");
    const claudeSettings = JSON.parse(await readFile(claudeSettingsPath, "utf8")) as {
      hooks: { Stop: Array<{ hooks: unknown[] }> };
    };
    claudeSettings.hooks.Stop[0]?.hooks.push({
      type: "command",
      command: "python \"$CLAUDE_PROJECT_DIR/.claude/hooks/self-check-scan.py\"",
      statusMessage: "Scanning self-check trap phrases",
      timeout: 5
    });
    await writeJson(claudeSettingsPath, claudeSettings);

    await expect(planHookConfigInstall(workspace)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ relativePath: ".claude/settings.json", action: "unchanged" })
      ])
    });

    await applyHookConfigUninstall(workspace);

    await expect(readFile(claudeSettingsPath, "utf8")).resolves.toContain("self-check-scan.py");
    await expect(readFile(claudeSettingsPath, "utf8")).resolves.not.toContain("agentq hook claude-code stop");
  });
});

async function createWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agentq-hooks-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
