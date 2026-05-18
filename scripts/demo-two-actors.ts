import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandRuntime } from "../packages/cli/src/main.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-demo-"));
const workspace = path.join(tempRoot, "workspace");
const stateRoot = path.join(tempRoot, "state");
await mkdir(workspace, { recursive: true });

const runtime: CommandRuntime = {
  cwd: workspace,
  env: { ...process.env, XDG_STATE_HOME: stateRoot },
  now: () => "2026-05-18T00:00:00.000Z"
};

const transcript: string[] = [];

const codex = await runAndRecord([
  "enter",
  "--as",
  "codex",
  "--session",
  "codex-demo",
  "--paths",
  "packages/core/src/**",
  "--responsibility",
  "protocol schema"
]);
const codexActor = codex.stdout.trim().replace(/ registered$/, "");

const claude = await runAndRecord([
  "enter",
  "--as",
  "claude-code",
  "--session",
  "claude-demo",
  "--paths",
  "README.md",
  "--responsibility",
  "public docs"
]);
const claudeActor = claude.stdout.trim().replace(/ registered$/, "");

await runAndRecord([
  "block",
  "--id",
  "AQ-0001",
  "--actor",
  codexActor,
  "--to",
  claudeActor,
  "--path",
  "README.md",
  "--summary",
  "README promises config that protocol forbids"
]);
await runAndRecord(["inbox", "--actor", claudeActor]);
await runAndRecord([
  "respond",
  "AQ-0001",
  "--actor",
  claudeActor,
  "--status",
  "resolved",
  "--evidence",
  "README now says no config and no repo .agentq"
]);
await runAndRecord(["done-check", "--actor", codexActor]);

const actual = `${transcript.join("\n\n")}\n`
  .replaceAll(codexActor, "<codex>")
  .replaceAll(claudeActor, "<claude>");
const expected = await readFile(
  new URL("../fixtures/demo/two-actors/expected.md", import.meta.url),
  "utf8"
);

if (!normalizeNewlines(expected).includes(normalizeNewlines(actual).trim())) {
  throw new Error(`Demo transcript drifted.\n\nActual:\n${actual}`);
}

async function runAndRecord(argv: readonly string[]) {
  transcript.push(`$ agentq ${argv.join(" ")}`);
  const result = await runCommand(argv, runtime);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output.length > 0) {
    transcript.push(output);
  }
  if (result.code !== 0) {
    throw new Error(`Command failed: agentq ${argv.join(" ")}\n${output}`);
  }

  return result;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
