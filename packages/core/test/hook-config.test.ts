import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyHookConfigInstall,
  applyHookConfigUninstall,
  planHookConfigInstall
} from "../src/index.js";

const CLAUDE_CODE_PRE_TOOL_MATCHER = "Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit";

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
      "hook claude-code stop"
    );
    await expect(readFile(path.join(workspace, ".claude", "settings.json"), "utf8")).resolves.toContain(
      `"matcher": "${CLAUDE_CODE_PRE_TOOL_MATCHER}"`
    );
    await expect(readFile(path.join(workspace, ".github", "hooks", "agentq.json"), "utf8")).resolves.toContain(
      "agentq hook copilot-cli pre-tool"
    );
  });

  it("upgrades existing AgentQ nested hook groups when matcher policy changes", async () => {
    const workspace = await createWorkspace();
    await writeJson(path.join(workspace, ".codex", "hooks.json"), {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "agentq hook codex pre-tool",
                statusMessage: "Updating AgentQ active scope",
                timeout: 10
              }
            ]
          }
        ]
      }
    });
    await writeJson(path.join(workspace, ".claude", "settings.json"), {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "agentq hook claude-code pre-tool",
                statusMessage: "Updating AgentQ active scope",
                timeout: 10
              }
            ]
          }
        ]
      }
    });

    await expect(planHookConfigInstall(workspace)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ relativePath: ".codex/hooks.json", action: "update" }),
        expect.objectContaining({ relativePath: ".claude/settings.json", action: "update" })
      ])
    });

    await applyHookConfigInstall(workspace);

    const codexHooks = await readFile(path.join(workspace, ".codex", "hooks.json"), "utf8");
    const claudeHooks = await readFile(path.join(workspace, ".claude", "settings.json"), "utf8");
    expect(codexHooks).toContain("\"matcher\": \"Read|Grep|Glob|LS|Bash|Edit|MultiEdit|Write\"");
    expect(codexHooks).not.toContain("\"matcher\": \"*\"");
    expect(claudeHooks).toContain(`"matcher": "${CLAUDE_CODE_PRE_TOOL_MATCHER}"`);
    expect(claudeHooks).not.toContain("\"matcher\": \"*\"");
  });

  it("uses direct Node Claude hook commands on Windows when an AgentQ entrypoint is available", async () => {
    const workspace = await createWorkspace();
    const restoreEnv = setInstallCommandEnv({
      AGENTQ_INSTALL_NODE_EXE: "C:\\Node\\node.exe",
      AGENTQ_INSTALL_AGENTQ_MAIN: "C:\\AgentQ\\dist\\main.js"
    });
    await writeJson(path.join(workspace, ".claude", "settings.json"), {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear|compact",
            hooks: [
              {
                type: "command",
                command: "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\agentq\\dist\\main.js\" hook claude-code session-start",
                statusMessage: "Registering AgentQ session",
                timeout: 10
              }
            ]
          }
        ],
        PreToolUse: [
          {
            matcher: "Read|Grep|Glob|LS|Bash|Edit|MultiEdit|Write",
            hooks: [
              {
                type: "command",
                command: "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\agentq\\dist\\main.js\" hook claude-code pre-tool",
                statusMessage: "Updating AgentQ active scope",
                timeout: 10
              }
            ]
          }
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\agentq\\dist\\main.js\" hook claude-code stop",
                statusMessage: "Checking AgentQ required replies",
                timeout: 10
              }
            ]
          }
        ]
      }
    });

    try {
      await expect(planHookConfigInstall(workspace)).resolves.toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ relativePath: ".claude/settings.json", action: "update" })
        ])
      });

      await applyHookConfigInstall(workspace);

      const claudeHooks = await readFile(path.join(workspace, ".claude", "settings.json"), "utf8");
      const claudeSettings = JSON.parse(claudeHooks) as {
        hooks: {
          SessionStart: Array<{ hooks: Array<{ command: string }> }>;
          PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
          Stop: Array<{ hooks: Array<{ command: string }> }>;
        };
      };
      if (process.platform === "win32") {
        expect(claudeSettings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(
          "\"C:\\Node\\node.exe\" \"C:\\AgentQ\\dist\\main.js\" hook claude-code session-start"
        );
        expect(claudeSettings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
          "\"C:\\Node\\node.exe\" \"C:\\AgentQ\\dist\\main.js\" hook claude-code pre-tool"
        );
        expect(claudeSettings.hooks.Stop[0]?.hooks[0]?.command).toBe(
          "\"C:\\Node\\node.exe\" \"C:\\AgentQ\\dist\\main.js\" hook claude-code stop"
        );
        expect(claudeHooks).not.toContain("agentq hook claude-code");
      } else {
        expect(claudeHooks).toContain("agentq hook claude-code session-start");
        expect(claudeHooks).toContain("agentq hook claude-code pre-tool");
        expect(claudeHooks).toContain("agentq hook claude-code stop");
      }
      expect(claudeSettings.hooks.PreToolUse[0]?.matcher).toBe(CLAUDE_CODE_PRE_TOOL_MATCHER);
    } finally {
      restoreEnv();
    }
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
    await expect(readFile(claudeSettingsPath, "utf8")).resolves.not.toContain("hook claude-code stop");
  });
});

async function createWorkspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "agentq-hooks-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setInstallCommandEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
