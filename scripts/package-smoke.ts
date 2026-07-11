import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.noDeprecation = true;

const EXPECTED_VERSION = "0.2.0";
const EXPECTED_AUTHOR = "Yonggyun Superlazy <seeddl4@gmail.com>";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "agentq-package-smoke-"));
const packDir = path.join(tempRoot, "pack");
const project = path.join(tempRoot, "consumer");
const workspace = path.join(tempRoot, "workspace-a");
const stateRoot = path.join(tempRoot, "state");
const profileRoot = path.join(tempRoot, "profile");
mkdirSync(packDir, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(workspace, { recursive: true });

run("corepack", ["pnpm", "build"], repoRoot);
run("corepack", ["pnpm", "--filter", "@agentq/core", "pack", "--pack-destination", packDir], repoRoot);
run("corepack", ["pnpm", "--filter", "agentq", "pack", "--pack-destination", packDir], repoRoot);

const coreTarball = findTarball(/^agentq-core-/);
const cliTarball = findTarball(/^agentq-\d/);
run("npm", ["init", "-y"], project);
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", coreTarball, cliTarball], project);

const coreRoot = path.join(project, "node_modules", "@agentq", "core");
const cliRoot = path.join(project, "node_modules", "agentq");
const workspaceMetadata = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
assert(workspaceMetadata.private === true, "workspace root must remain private");
assert(workspaceMetadata.version === "0.0.0", "workspace root version must remain 0.0.0");
assertRealDirectory(coreRoot);
assertRealDirectory(cliRoot);
assertPackageMetadata(coreRoot, "@agentq/core", false);
assertPackageMetadata(cliRoot, "agentq", true);
const installedCliMetadata = JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf8"));
assert(
  installedCliMetadata.dependencies?.["@agentq/core"] === EXPECTED_VERSION,
  "packed CLI dependency was not rewritten to exact core version"
);
assertPublicTarballTree(coreTarball);
assertPublicTarballTree(cliTarball);

const binPath = process.platform === "win32"
  ? path.join(project, "node_modules", ".bin", "agentq.cmd")
  : path.join(project, "node_modules", ".bin", "agentq");
assert(existsSync(binPath), `missing installed agentq bin: ${binPath}`);

const coreKeys = JSON.parse(runNode(
  "console.log(JSON.stringify(Object.keys(await import('@agentq/core')).sort()))"
));
for (const required of [
  "registerAdapterSession",
  "setClaims",
  "clearClaims",
  "findOwners",
  "createQuestion",
  "answerQuestion",
  "declineQuestionAsNotMine",
  "cancelQuestion",
  "listInbox"
]) {
  assert(coreKeys.includes(required), `core root export missing ${required}`);
}
assert(
  runNode("console.log(typeof (await import('agentq/adapters/codex')).runCodexHook)").trim() === "function",
  "agentq/adapters/codex export missing"
);
assert(
  runNode("console.log(typeof (await import('agentq/adapters/claude')).runClaudeHook)").trim() === "function",
  "agentq/adapters/claude export missing"
);

const help = runCli(["--help"]);
for (const command of [
  "register",
  "claims set",
  "claims clear",
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
]) {
  assert(help.includes(`agentq ${command}`), `help missing ${command}`);
}
assertNoMatch(help, /\b(?:enter|next|work|p[d]ac|note|block|respond|supersede|follow-up|done-check|wake)\b/i, "legacy command");

const dryRun = parseJson(runCli(["install"]));
assert(dryRun.code === "install_plan" && dryRun.mode === "dry-run", "install default is not dry-run");
assert(!existsSync(path.join(workspace, ".codex")), "dry-run wrote .codex");
assert(!existsSync(path.join(workspace, ".claude")), "dry-run wrote .claude");

const installed = parseJson(runCli(["install", "--yes"]));
assert(installed.code === "installed", "install --yes did not apply");
assert(!existsSync(path.join(workspace, "AGENTS.md")), "install wrote AGENTS.md");
assert(!existsSync(path.join(workspace, "CLAUDE.md")), "install wrote CLAUDE.md");
assert(!existsSync(path.join(workspace, ".github")), "install wrote an unapproved GitHub surface");
const codexConfigPath = path.join(workspace, ".codex", "hooks.json");
const claudeConfigPath = path.join(workspace, ".claude", "settings.json");
const codexConfig = JSON.parse(readFileSync(codexConfigPath, "utf8"));
const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf8"));
assertOwnedHookShape(codexConfig, "codex");
assertOwnedHookShape(claudeConfig, "claude");

const codexCommands = ownedCommands(codexConfig);
const claudeCommands = ownedCommands(claudeConfig);
assert(codexCommands.length === 2, `expected two Codex hook commands, got ${codexCommands.length}`);
assert(claudeCommands.length === 2, `expected two Claude hook commands, got ${claudeCommands.length}`);
assertQuietHook(
  commandFor(codexCommands, "session-start"),
  {
    session_id: "session-a",
    ["trans" + "cript_path"]: null,
    cwd: workspace,
    hook_event_name: "SessionStart",
    model: "gpt-test",
    permission_mode: "default",
    source: "startup"
  }
);
assertQuietHook(
  commandFor(codexCommands, "pre-tool-use"),
  {
    session_id: "session-a",
    turn_id: "turn-a",
    cwd: workspace,
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Update File: src/file.ts\n@@\n-old\n+new\n*** End Patch\n"
    },
    tool_use_id: "tool-a",
    model: "gpt-test",
    permission_mode: "default",
    ["trans" + "cript_path"]: null
  }
);
assertQuietHook(
  commandFor(claudeCommands, "session-start"),
  {
    session_id: "session-b",
    ["trans" + "cript_path"]: path.join(workspace, "trans" + "cript.jsonl"),
    cwd: workspace,
    hook_event_name: "SessionStart",
    source: "startup"
  }
);
assertQuietHook(
  commandFor(claudeCommands, "pre-tool-use"),
  {
    session_id: "session-b",
    ["trans" + "cript_path"]: path.join(workspace, "trans" + "cript.jsonl"),
    cwd: workspace,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(workspace, "src", "file.ts"), content: "x" },
    tool_use_id: "tool-b"
  }
);

const doctor = parseJson(runCli(["doctor"]));
assert(doctor.code === "doctor", "doctor did not return diagnostics");
const uninstall = parseJson(runCli(["uninstall", "--yes"]));
assert(uninstall.code === "uninstalled", "uninstall --yes did not apply");
assert(!existsSync(codexConfigPath), "uninstall left owned Codex hooks");
assert(!existsSync(claudeConfigPath), "uninstall left owned Claude hooks");
assert(!existsSync(path.join(workspace, ".codex", "config.toml")), "uninstall left owned Codex feature config");

scanInstalledPackage(coreRoot);
scanInstalledPackage(cliRoot);
console.log(`package smoke passed: ${tempRoot}`);

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runNode(source: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runCli(args: readonly string[]): string {
  const entrypoint = path.join(cliRoot, "dist", "main.js");
  return execFileSync(process.execPath, [entrypoint, ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: commandEnv(),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function assertQuietHook(command: string, payload: unknown): void {
  const output = execSync(command, {
    cwd: workspace,
    encoding: "utf8",
    env: commandEnv(),
    input: JSON.stringify(payload),
    shell: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert(output === "", `hook output was not byte-empty: ${JSON.stringify(output)}`);
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOCALAPPDATA: stateRoot,
    HOME: profileRoot,
    USERPROFILE: profileRoot,
    CODEX_HOME: path.join(profileRoot, ".codex")
  };
}

function findTarball(prefix: RegExp): string {
  const name = readdirSync(packDir)
    .filter((entry) => prefix.test(entry) && entry.endsWith(".tgz"))
    .sort()
    .at(-1);
  assert(name !== undefined, `missing tarball matching ${prefix}`);
  return path.join(packDir, name);
}

function assertPackageMetadata(root: string, name: string, hasBin: boolean): void {
  const metadata = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert(metadata.name === name, `${name} package name mismatch`);
  assert(metadata.version === EXPECTED_VERSION, `${name} version is ${metadata.version}, expected ${EXPECTED_VERSION}`);
  assert(metadata.author === EXPECTED_AUTHOR, `${name} author mismatch`);
  assert(metadata.license === "MIT", `${name} license mismatch`);
  assert(Boolean(metadata.bin) === hasBin, `${name} bin boundary mismatch`);
  const license = readFileSync(path.join(root, "LICENSE"), "utf8");
  assert(license.includes("MIT License"), `${name} tarball is missing MIT text`);
  const copyrightLines = license
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Copyright"));
  assert(
    copyrightLines.length === 1 &&
      copyrightLines[0] === "Copyright (c) 2026 Yonggyun Superlazy",
    `${name} tarball license holder mismatch`
  );
}

function assertPublicTarballTree(tarball: string): void {
  const entries = run("tar", ["-tf", tarball], repoRoot).split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    assertNoMatch(
      entry,
      /(?:^|\/)(?:src|test|fixtures|scripts|docs|\.github)(?:\/|$)|\.tsbuildinfo$|node_modules/i,
      "non-public tarball path"
    );
  }
}

function scanInstalledPackage(root: string): void {
  const texts: string[] = [];
  for (const relative of listFiles(root, "")) {
    if (/\.(?:js|cjs|mjs|json|d\.ts|map|md|txt)$/i.test(relative)) {
      texts.push(readFileSync(path.join(root, relative), "utf8"));
    }
  }
  const joined = texts.join("\n");
  assertNoMatch(joined, /C:\\Users\\|E:\\superlazy/i, "private absolute path");
  const privateNames = [
    "Project" + "DD",
    "Project" + "SHE",
    "Project" + "SORI",
    "Project" + "MK",
    "DD" + "Setup",
    "SHE" + "Setup"
  ];
  assertNoMatch(joined, new RegExp(privateNames.join("|"), "i"), "private project name");
  const retiredNames = ["Co" + "pilot", "P" + "DAC", "work" + "-stack", "answer" + "-quality"];
  assertNoMatch(joined, new RegExp(`\\b(?:${retiredNames.join("|")})\\b`, "i"), "retired product surface");
}

function listFiles(root: string, relative: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function assertOwnedHookShape(config: any, adapter: "codex" | "claude"): void {
  const hooks = config.hooks;
  assert(hooks !== null && typeof hooks === "object", `${adapter} hooks missing`);
  assert(Object.keys(hooks).sort().join(",") === "PreToolUse,SessionStart", `${adapter} installed extra events`);
  assert(hooks.SessionStart.length === 1, `${adapter} SessionStart count mismatch`);
  assert(hooks.SessionStart[0].matcher === "startup|resume", `${adapter} SessionStart matcher mismatch`);
  assert(hooks.PreToolUse.length === 1, `${adapter} PreToolUse count mismatch`);
  assert(
    hooks.PreToolUse[0].matcher === (adapter === "codex" ? "apply_patch" : "Edit|Write"),
    `${adapter} PreToolUse matcher mismatch`
  );
  const text = JSON.stringify(config);
  assertNoMatch(text, /\b(?:Stop|Bash|PowerShell|Read|MultiEdit|MCP|Co[p]ilot)\b/i, "broad installed hook");
  assertNoMatch(text, /marker|AGENTS\.md|CLAUDE\.md/i, "instruction marker");
}

function ownedCommands(config: any): string[] {
  return [
    ...config.hooks.SessionStart,
    ...config.hooks.PreToolUse
  ].map((entry: any) => String(entry.hooks[0].command));
}

function commandFor(commands: readonly string[], suffix: string): string {
  const command = commands.find((candidate) => candidate.endsWith(` ${suffix}`));
  assert(command !== undefined, `missing installed ${suffix} command`);
  return command;
}

function assertRealDirectory(directory: string): void {
  assert(existsSync(directory), `missing installed directory: ${directory}`);
  const stat = lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `installed package is not a real directory: ${directory}`);
}

function parseJson(source: string): any {
  return JSON.parse(source);
}

function assertNoMatch(value: string, pattern: RegExp, label: string): void {
  assert(!pattern.test(value), `${label} matched ${pattern}: ${value.slice(0, 300)}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
