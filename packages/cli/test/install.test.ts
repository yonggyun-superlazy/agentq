import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand, type CommandResult, type CommandRuntime } from "../src/main.js";

describe("project-local installer", () => {
  it("defaults to an all-adapter dry-run that writes nothing", async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture.root);

    const result = resultJson(await runCommand(["install"], fixture.runtime));

    expect(result).toMatchObject({
      code: "install_plan",
      mode: "dry-run",
      adapters: ["codex", "claude"]
    });
    expect(await snapshot(fixture.root)).toEqual(before);
  });

  it("merges only narrow project hooks and removes only exact owned entries", async () => {
    const fixture = await createFixture();
    await writeJson(path.join(fixture.workspace, ".codex", "hooks.json"), {
      keep: true,
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "user-handler" }] }
        ]
      }
    });
    await writeJson(path.join(fixture.workspace, ".claude", "settings.json"), {
      keep: true,
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "user-handler" }] }
        ]
      }
    });
    const profileBefore = await snapshot(fixture.profileRoot);

    const installed = resultJson(
      await runCommand(["install", "--adapter", "all", "--yes"], fixture.runtime)
    );
    expect(installed).toMatchObject({ code: "installed", mode: "applied" });

    const codexPath = path.join(fixture.workspace, ".codex", "hooks.json");
    const claudePath = path.join(fixture.workspace, ".claude", "settings.json");
    const codex = JSON.parse(await readFile(codexPath, "utf8"));
    const claude = JSON.parse(await readFile(claudePath, "utf8"));
    expect(codex.keep).toBe(true);
    expect(claude.keep).toBe(true);
    expect(codex.hooks.SessionStart).toContainEqual(ownedHook(
      "startup|resume",
      `${fixture.handlerCommand} hook codex session-start`,
      true
    ));
    expect(codex.hooks.PreToolUse).toContainEqual(ownedHook(
      "apply_patch",
      `${fixture.handlerCommand} hook codex pre-tool-use`,
      true
    ));
    expect(claude.hooks.SessionStart).toContainEqual(ownedHook(
      "startup|resume",
      `${fixture.handlerCommand} hook claude session-start`,
      false
    ));
    expect(claude.hooks.PreToolUse).toContainEqual(ownedHook(
      "Edit|Write",
      `${fixture.handlerCommand} hook claude pre-tool-use`,
      false
    ));
    expect(Object.keys(codex.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    expect(Object.keys(claude.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart"
    ]);
    const ownedText = JSON.stringify([
      ...codex.hooks.SessionStart,
      ...codex.hooks.PreToolUse.filter((entry: unknown) =>
        JSON.stringify(entry).includes(fixture.handlerCommand)
      ),
      ...claude.hooks.SessionStart,
      ...claude.hooks.PreToolUse
    ]);
    expect(ownedText).not.toMatch(/Stop|Shell|PowerShell|Read\||status|marker|mcp|co[p]ilot/i);
    await expect(
      readFile(path.join(fixture.workspace, ".codex", "config.toml"), "utf8")
    ).resolves.toBe("[features]\nhooks = true\n");
    await expect(readFile(path.join(fixture.workspace, "AGENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(path.join(fixture.workspace, "CLAUDE.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await snapshot(fixture.profileRoot)).toEqual(profileBefore);

    const ownedCodexEntry = codex.hooks.PreToolUse.find(
      (entry: any) => entry.matcher === "apply_patch" && entry.hooks?.[0]?.command !== "user-handler"
    );
    const ownedCodexCommand = ownedCodexEntry.hooks[0];
    ownedCodexEntry.hooks[0] = {
      commandWindows: ownedCodexCommand.commandWindows,
      command: ownedCodexCommand.command,
      type: ownedCodexCommand.type
    };
    codex.hooks.PreToolUse.push({
      matcher: "apply_patch",
      hooks: [{ type: "command", command: "user-same-matcher" }]
    });
    await writeJson(codexPath, codex);
    const beforeDryUninstall = await snapshot(fixture.root);
    expect(resultJson(await runCommand(["uninstall"], fixture.runtime))).toMatchObject({
      code: "uninstall_plan",
      mode: "dry-run"
    });
    expect(await snapshot(fixture.root)).toEqual(beforeDryUninstall);

    expect(resultJson(await runCommand(["uninstall", "--yes"], fixture.runtime))).toMatchObject({
      code: "uninstalled",
      mode: "applied"
    });
    const codexAfter = JSON.parse(await readFile(codexPath, "utf8"));
    const claudeAfter = JSON.parse(await readFile(claudePath, "utf8"));
    expect(JSON.stringify(codexAfter)).not.toContain(fixture.handlerCommand);
    expect(JSON.stringify(claudeAfter)).not.toContain(fixture.handlerCommand);
    expect(codexAfter.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "user-handler" }] },
      { matcher: "apply_patch", hooks: [{ type: "command", command: "user-same-matcher" }] }
    ]);
    expect(claudeAfter.hooks.PostToolUse).toHaveLength(1);
    await expect(
      readFile(path.join(fixture.workspace, ".codex", "config.toml"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    const afterFirst = await snapshot(fixture.root);
    await expect(runCommand(["uninstall", "--yes"], fixture.runtime)).resolves.toMatchObject({
      code: 0
    });
    expect(await snapshot(fixture.root)).toEqual(afterFirst);
    expect(await snapshot(fixture.profileRoot)).toEqual(profileBefore);
  });

  it("limits first-party adapter selection and rejects unsafe existing Codex feature state", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.workspace, ".codex"), { recursive: true });
    await writeFile(
      path.join(fixture.workspace, ".codex", "config.toml"),
      "[features]\nhooks = false\n[other]\nkeep = true\n",
      "utf8"
    );
    const before = await snapshot(fixture.root);

    await expect(
      runCommand(["install", "--adapter", "vendor-one", "--yes"], fixture.runtime)
    ).resolves.toMatchObject({ code: 2, stderr: expect.stringContaining("invalid_adapter") });
    await expect(
      runCommand(["install", "--adapter", "codex", "--yes"], fixture.runtime)
    ).resolves.toMatchObject({ code: 2, stderr: expect.stringContaining("codex_hooks_disabled") });
    expect(await snapshot(fixture.root)).toEqual(before);
  });

  it("preserves a valid dotted-key Codex feature config byte-for-byte", async () => {
    const fixture = await createFixture();
    const configPath = path.join(fixture.workspace, ".codex", "config.toml");
    const source = "features.hooks = true\nother = \"keep\"\n";
    await writeFileSafe(configPath, source);

    await expect(
      runCommand(["install", "--adapter", "codex", "--yes"], fixture.runtime)
    ).resolves.toMatchObject({ code: 0 });

    await expect(readFile(configPath, "utf8")).resolves.toBe(source);
  });
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly profileRoot: string;
  readonly handlerCommand: string;
  readonly runtime: CommandRuntime & {
    readonly nodePath: string;
    readonly entrypointPath: string;
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentq-installer-"));
  const workspace = path.join(root, "workspace-a");
  const profileRoot = path.join(root, "profile");
  const nodePath = path.join(root, "bin", "node.exe");
  const entrypointPath = path.join(root, "bin", "agentq-main.js");
  await mkdir(workspace, { recursive: true });
  await writeFileSafe(path.join(profileRoot, ".codex", "config.toml"), "profile-codex-sentinel\n");
  await writeFileSafe(path.join(profileRoot, ".claude", "settings.json"), "profile-claude-sentinel\n");
  const handlerCommand = `"${nodePath}" "${entrypointPath}"`;
  return {
    root,
    workspace,
    profileRoot,
    handlerCommand,
    runtime: {
      cwd: workspace,
      env: {
        LOCALAPPDATA: path.join(root, "state"),
        HOME: profileRoot,
        USERPROFILE: profileRoot,
        CODEX_HOME: path.join(profileRoot, ".codex")
      },
      now: () => "2026-07-11T00:00:00.000Z",
      nodePath,
      entrypointPath
    }
  };
}

function ownedHook(matcher: string, command: string, codex: boolean) {
  return {
    matcher,
    hooks: [
      {
        type: "command",
        command,
        ...(codex ? { commandWindows: command } : {})
      }
    ]
  };
}

function resultJson(result: CommandResult): Record<string, any> {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFileSafe(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileSafe(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

async function snapshot(root: string): Promise<readonly string[]> {
  const { createHash } = await import("node:crypto");
  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  async function walk(relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  await walk("");
  return await Promise.all(
    files.sort().map(async (relative) => {
      const bytes = await readFile(path.join(root, relative));
      return `${relative.replace(/\\/g, "/")}\0${createHash("sha256").update(bytes).digest("hex")}`;
    })
  );
}
