import { spawnSync } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS, renderHelp, runCommand } from "../src/main.js";

const TOP_LEVEL_COMMANDS = [
  "register",
  "claims",
  "owners",
  "question",
  "answer",
  "not_mine",
  "cancel",
  "inbox",
  "install",
  "uninstall",
  "doctor",
  "hook"
] as const;

const PUBLIC_USAGE = [
  "agentq register --adapter <adapter-id> --session <native-id>",
  "agentq claims set --actor <id> [--path <path>]... [--resource <id>]... [--contract <id>]...",
  "agentq claims clear --actor <id>",
  "agentq owners --actor <requester> [--path <path>]... [--resource <id>]... [--contract <id>]...",
  "agentq question --actor <sender> --to <recipient> --question <text> [scope options]",
  "agentq answer <question-id> --actor <recipient> --answer <text>",
  "agentq not_mine <question-id> --actor <recipient>",
  "agentq cancel <question-id> --actor <sender>",
  "agentq inbox --actor <recipient>",
  "agentq install [--adapter codex|claude|all] [--dry-run|--yes]",
  "agentq uninstall [--adapter codex|claude|all] [--dry-run|--yes]",
  "agentq doctor",
  "agentq hook <codex|claude> <session-start|pre-tool-use>"
] as const;

describe("reduced CLI help", () => {
  it("exposes exactly the reduced top-level command set", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual(TOP_LEVEL_COMMANDS);
  });

  it("prints every exact public usage and none of the removed surface", () => {
    const help = renderHelp();

    for (const usage of PUBLIC_USAGE) {
      expect(help).toContain(usage);
    }

    const removedCommands = [
      "enter",
      "next",
      "work",
      "p" + "dac",
      "note",
      "block",
      "respond",
      "supersede",
      "follow-up",
      "done-check",
      "wake"
    ];
    const lowerHelp = help.toLowerCase();
    for (const command of removedCommands) {
      const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(lowerHelp).not.toMatch(new RegExp(`agentq\\s+${escaped}(?:\\s|$)`));
    }

    const removedPhrases = [
      "mcp",
      "co" + "pilot",
      "behavioral evaluation",
      "completion policy"
    ];
    for (const phrase of removedPhrases) {
      expect(lowerHelp).not.toContain(phrase);
    }
  });

  it("provides help for every top-level command and both claims subcommands", async () => {
    for (const command of TOP_LEVEL_COMMANDS) {
      await expect(runCommand([command, "--help"])).resolves.toMatchObject({
        code: 0,
        stderr: ""
      });
    }
    await expect(runCommand(["claims", "set", "--help"])).resolves.toEqual({
      code: 0,
      stdout: `${PUBLIC_USAGE[1]}\n`,
      stderr: ""
    });
    await expect(runCommand(["claims", "clear", "--help"])).resolves.toEqual({
      code: 0,
      stdout: `${PUBLIC_USAGE[2]}\n`,
      stderr: ""
    });
  });

  it("returns a stable unknown-command diagnostic", async () => {
    await expect(runCommand(["unknown"])).resolves.toEqual({
      code: 2,
      stdout: "",
      stderr: "agentq:unknown_command: unknown command: unknown\n"
    });
  });

  it("prints help when the executable entrypoint uses a filesystem alias", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const root = await mkdtemp(path.join(os.tmpdir(), "agentq-help-alias-"));
    const aliasRoot = path.join(root, "repo-alias");
    await symlink(repoRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const entrypoint = path.join(aliasRoot, "packages", "cli", "src", "main.ts");

    const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint, "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(PUBLIC_USAGE[0]);
  });
});
