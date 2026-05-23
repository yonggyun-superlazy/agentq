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
  env: { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
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
  "src/protocol.ts",
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
  "src/consumer.ts",
  "--responsibility",
  "protocol consumer"
]);
const claudeActor = claude.stdout.trim().replace(/ registered$/, "");

await runAndRecord([
  "owners",
  "--actor",
  claudeActor,
  "--path",
  "src/protocol.ts"
]);
await runAndRecord([
  "question",
  "--id",
  "AQ-0001",
  "--actor",
  claudeActor,
  "--to",
  codexActor,
  "--path",
  "src/protocol.ts",
  "--question",
  "I need to change src/protocol.ts. Are you actively changing the protocol schema?",
  "--expect",
  "Answer with active edits or clear-to-edit evidence."
]);
await runAndRecord(["done-check", "--actor", claudeActor], 2);
await runAndRecord(["inbox", "--actor", codexActor]);
await runAndRecord([
  "respond",
  "AQ-0001",
  "--actor",
  codexActor,
  "--status",
  "answered",
  "--evidence",
  "No active schema edit; preserve RequiredRequest routing evidence fields."
]);
await runAndRecord(["done-check", "--actor", claudeActor]);

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

async function runAndRecord(argv: readonly string[], expectedCode = 0) {
  transcript.push(`$ agentq ${argv.join(" ")}`);
  const result = await runCommand(argv, runtime);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output.length > 0) {
    transcript.push(output);
  }
  if (result.code !== expectedCode) {
    throw new Error(`Command failed: agentq ${argv.join(" ")}\n${output}`);
  }

  return result;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
