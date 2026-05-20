import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.noDeprecation = true;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "agentq-package-smoke-"));
const packDir = path.join(tempRoot, "pack");
const prefix = path.join(tempRoot, "prefix");
const workspace = path.join(tempRoot, "workspace with spaces");
mkdirSync(packDir, { recursive: true });
mkdirSync(prefix, { recursive: true });
mkdirSync(workspace, { recursive: true });

run("corepack", ["pnpm", "build"], repoRoot);
run("corepack", ["pnpm", "--filter", "@agentq/core", "pack", "--pack-destination", packDir], repoRoot);
run("corepack", ["pnpm", "--filter", "agentq", "pack", "--pack-destination", packDir], repoRoot);

const coreTarball = findTarball((entry) => /^agentq-core-\d/.test(entry));
const cliTarball = findTarball((entry) => /^agentq-\d/.test(entry));
run("npm", ["install", "--global", "--prefix", prefix, coreTarball, cliTarball], repoRoot);

const agentqBin = process.platform === "win32"
  ? path.join(prefix, "agentq.cmd")
  : path.join(prefix, "bin", "agentq");
assert(existsSync(agentqBin), `missing installed agentq binary at ${agentqBin}`);

const help = runAgentq(["--help"], workspace);
assert(help.includes("The handshake between coding agents."), "installed binary help is missing tagline");
assertPackageMetadata();

const dryRun = runAgentq(["install", "--dry-run"], workspace);
assert(dryRun.includes("Mode: no files written"), "install dry-run did not stay read-only");
assert(!existsSync(path.join(workspace, "AGENTS.md")), "install dry-run wrote AGENTS.md");

runAgentq(["install", "--yes"], workspace);
assert(readFile(path.join(workspace, "AGENTS.md")).includes("agentq:begin"), "install missed AGENTS marker");
assert(readFile(path.join(workspace, ".codex", "hooks.json")).includes("agentq hook codex stop"), "install missed Codex hook");
assert(readFile(path.join(workspace, ".codex", "hooks.json")).includes("agentq hook codex pre-tool"), "install missed Codex prehook");
assert(readFile(path.join(workspace, ".claude", "settings.json")).includes("agentq hook claude-code stop"), "install missed Claude hook");
assert(readFile(path.join(workspace, ".claude", "settings.json")).includes("agentq hook claude-code pre-tool"), "install missed Claude prehook");
assert(readFile(path.join(workspace, ".github", "hooks", "agentq.json")).includes("agentq hook copilot-cli stop"), "install missed Copilot hook");
assert(readFile(path.join(workspace, ".github", "hooks", "agentq.json")).includes("agentq hook copilot-cli pre-tool"), "install missed Copilot prehook");
assert(!existsSync(path.join(workspace, ".agentq")), "install created repo-local .agentq");
assertInstalledHookCommandsExecute();

const doctor = runAgentq(["doctor"], workspace);
assert(doctor.includes("AgentQ doctor: ok"), "doctor did not report ok after install");

const sessionStart = runAgentq(
  ["hook", "codex", "session-start"],
  workspace,
  JSON.stringify({
    session_id: "package-smoke",
    cwd: workspace,
    hook_event_name: "SessionStart",
    source: "startup"
  })
);
assert(sessionStart.includes("AgentQ actor id:"), "SessionStart hook did not return actor context");
const actorId = actorIdFromHookOutput(sessionStart);

const unscopedStop = runAgentq(
  ["hook", "codex", "stop"],
  workspace,
  JSON.stringify({
    session_id: "package-smoke",
    cwd: workspace,
    hook_event_name: "Stop",
    stop_hook_active: false
  })
);
assert(unscopedStop.includes("scope-check failed"), `Stop hook should require concrete scope before finishing, got ${unscopedStop}`);

runAgentq([
  "enter",
  "--actor",
  actorId,
  "--paths",
  "src/package-smoke.ts",
  "--responsibility",
  "package smoke verification"
], workspace);
const scope = runAgentq(["scope-check", "--actor", actorId], workspace);
assert(scope.includes("ok: actor scope is specific"), `scope-check did not pass after enter --actor, got ${scope}`);

const stop = runAgentq(
  ["hook", "codex", "stop"],
  workspace,
  JSON.stringify({
    session_id: "package-smoke",
    cwd: workspace,
    hook_event_name: "Stop",
    stop_hook_active: false
  })
);
assert(stop.trim() === "{}", `Stop hook should pass without blockers, got ${stop}`);

const preTool = runAgentq(
  ["hook", "codex", "pre-tool"],
  workspace,
  JSON.stringify({
    session_id: "package-smoke",
    cwd: workspace,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "src/package-smoke.ts" }
  })
);
assert(preTool.trim() === "{}", `PreTool hook should pass, got ${preTool}`);

const wakeReceiver = runAgentq([
  "enter",
  "--as",
  "claude-code",
  "--session",
  "package-smoke-wake-claude",
  "--paths",
  "src/package-smoke.ts",
  "--responsibility",
  "package smoke wake receiver"
], workspace).trim().replace(/ registered$/, "");
runAgentq([
  "question",
  "--id",
  "AQ-package-wake",
  "--actor",
  actorId,
  "--to",
  wakeReceiver,
  "--path",
  "src/package-smoke.ts",
  "--question",
  "Package smoke wake dry-run",
  "--pass",
  "wake receiver can be resumed"
], workspace);
const wakeList = runAgentq(["wake", "list"], workspace);
assert(wakeList.includes(wakeReceiver), `wake list missed receiver: ${wakeList}`);
const wakeDryRun = runAgentq(["wake", "--actor", wakeReceiver], workspace);
assert(wakeDryRun.includes("command: claude"), `wake dry-run missed Claude command: ${wakeDryRun}`);
assert(wakeDryRun.includes("AQ-package-wake"), `wake dry-run missed pending message: ${wakeDryRun}`);
runAgentq([
  "respond",
  "AQ-package-wake",
  "--actor",
  wakeReceiver,
  "--status",
  "answered",
  "--evidence",
  "package smoke wake dry-run verified"
], workspace);

runAgentq(["uninstall", "--yes"], workspace);
assert(!readFile(path.join(workspace, "AGENTS.md")).includes("agentq:begin"), "uninstall left AGENTS marker");
assert(!existsSync(path.join(workspace, ".codex", "hooks.json")), "uninstall left AgentQ-only Codex hook file");
assert(!existsSync(path.join(workspace, ".github", "hooks", "agentq.json")), "uninstall left AgentQ-only Copilot hook file");

console.log(`package smoke passed: ${tempRoot}`);

function run(command: string, args: readonly string[], cwd: string, input?: string): string {
  if (process.platform === "win32") {
    return execFileSync(command, [...args], {
      cwd,
      encoding: "utf8",
      input,
      shell: true,
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]
    });
  }

  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    input,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]
  });
}

function runAgentq(args: readonly string[], cwd: string, input?: string): string {
  if (process.platform !== "win32") {
    return run(agentqBin, args, cwd, input);
  }

  return execFileSync(agentqBin, [...args], {
    cwd,
    encoding: "utf8",
    input,
    shell: true,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]
  });
}

function assertInstalledHookCommandsExecute(): void {
  const hookConfigPaths = [
    path.join(workspace, ".codex", "hooks.json"),
    path.join(workspace, ".claude", "settings.json"),
    path.join(workspace, ".github", "hooks", "agentq.json")
  ];
  const commands = [...new Set(
    hookConfigPaths.flatMap((filePath) => collectAgentQHookCommands(JSON.parse(readFile(filePath))))
  )].sort();
  assert(commands.length === 9, `expected 9 installed AgentQ hook commands, got ${commands.length}: ${commands.join(", ")}`);

  for (const command of commands) {
    const output = runInstalledHookCommand(command, hookPayload(command));
    assertJsonOutput(command, output);
  }
}

function collectAgentQHookCommands(value: unknown): string[] {
  if (typeof value === "string") {
    return value.startsWith("agentq hook ") ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectAgentQHookCommands);
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  return Object.values(value).flatMap(collectAgentQHookCommands);
}

function runInstalledHookCommand(command: string, input: string): string {
  return execSync(command, {
    cwd: workspace,
    encoding: "utf8",
    env: installedCommandEnv(),
    input,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function installedCommandEnv(): NodeJS.ProcessEnv {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const existingPath = process.env[pathKey] ?? process.env.PATH ?? "";

  return {
    ...process.env,
    [pathKey]: `${binDir}${path.delimiter}${existingPath}`
  };
}

function hookPayload(command: string): string {
  const adapter = command.includes(" claude-code ")
    ? "claude-code"
    : command.includes(" copilot-cli ")
      ? "copilot-cli"
      : "codex";
  const event = command.endsWith(" session-start")
    ? "SessionStart"
    : command.endsWith(" pre-tool")
      ? "PreToolUse"
      : "Stop";

  return JSON.stringify({
    session_id: `package-smoke-${adapter}`,
    cwd: workspace,
    hook_event_name: event,
    stop_hook_active: false,
    tool_name: "Read",
    tool_input: { file_path: "src/package-smoke.ts" }
  });
}

function assertJsonOutput(command: string, output: string): void {
  const parsed = JSON.parse(output) as unknown;
  assert(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), `${command} returned non-object JSON`);
  if (command.endsWith(" session-start")) {
    assert(output.includes("AgentQ actor id:"), `${command} did not return actor context`);
  }
}

function findTarball(predicate: (entry: string) => boolean): string {
  const fileName = readdirSync(packDir)
    .filter((entry) => predicate(entry) && entry.endsWith(".tgz"))
    .sort()
    .at(-1);
  assert(fileName !== undefined, "missing expected tarball");
  return path.join(packDir, fileName);
}

function assertPackageMetadata(): void {
  assertPublishablePackageMetadata(path.join(repoRoot, "packages", "cli", "package.json"), {
    name: "agentq",
    version: "0.1.0",
    bin: true
  });
  assertPublishablePackageMetadata(path.join(repoRoot, "packages", "core", "package.json"), {
    name: "@agentq/core",
    version: "0.1.0",
    bin: false
  });
  assert(readFile(path.join(repoRoot, "LICENSE")).includes("MIT License"), "missing MIT LICENSE");
}

function assertPublishablePackageMetadata(
  filePath: string,
  expected: { readonly name: string; readonly version: string; readonly bin: boolean }
): void {
  const pkg = JSON.parse(readFile(filePath)) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly license?: unknown;
    readonly repository?: { readonly url?: unknown };
    readonly bugs?: { readonly url?: unknown };
    readonly homepage?: unknown;
    readonly engines?: { readonly node?: unknown };
    readonly publishConfig?: { readonly access?: unknown; readonly provenance?: unknown };
    readonly bin?: unknown;
  };
  assert(pkg.name === expected.name, `${filePath} has wrong package name`);
  assert(pkg.version === expected.version, `${filePath} has wrong version`);
  assert(pkg.license === "MIT", `${filePath} must declare MIT license`);
  assert(
    typeof pkg.repository?.url === "string" && pkg.repository.url.includes("github.com/yonggyun-superlazy/agentq"),
    `${filePath} is missing repository metadata`
  );
  assert(typeof pkg.bugs?.url === "string", `${filePath} is missing bugs metadata`);
  assert(typeof pkg.homepage === "string", `${filePath} is missing homepage metadata`);
  assert(pkg.engines?.node === ">=20", `${filePath} must declare supported Node engine`);
  assert(pkg.publishConfig?.access === "public", `${filePath} must publish as public`);
  assert(pkg.publishConfig?.provenance === true, `${filePath} must request npm provenance`);
  if (expected.bin) {
    assert(pkg.bin !== undefined, `${filePath} is missing CLI bin metadata`);
  }
}

function actorIdFromHookOutput(output: string): string {
  const match = output.match(/AgentQ actor id:\s*([^.\s]+(?:\.[^.\s]+)*)\./);
  assert(match?.[1] !== undefined, `missing actor id in hook output: ${output}`);
  return match[1];
}

function readFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
