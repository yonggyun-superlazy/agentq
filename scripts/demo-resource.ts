import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandRuntime } from "../packages/cli/src/main.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-resource-demo-"));
const workspace = path.join(tempRoot, "workspace");
const stateRoot = path.join(tempRoot, "state");
await mkdir(workspace, { recursive: true });

const runtime: CommandRuntime = {
  cwd: workspace,
  env: { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
  now: () => "2026-05-18T00:00:00.000Z"
};

const transcript: string[] = [];

const owner = await runAndRecord([
  "enter",
  "--as",
  "codex",
  "--session",
  "dd-setup-owner",
  "--paths",
  "ProjectDD/Data",
  "--resource",
  "setup-watcher:ProjectDD/DDSetup",
  "--responsibility",
  "DD setup watcher and generated data validation"
]);
const ownerActor = owner.stdout.trim().replace(/ registered$/, "");

const caller = await runAndRecord([
  "enter",
  "--as",
  "claude-code",
  "--session",
  "dd-test-caller",
  "--paths",
  "ProjectDD/DDUnityTestHost/Assets/Tests",
  "--responsibility",
  "DD Unity test coverage"
]);
const callerActor = caller.stdout.trim().replace(/ registered$/, "");

await runAndRecord([
  "owners",
  "--actor",
  callerActor,
  "--resource",
  "setup-watcher:ProjectDD/DDSetup"
]);
await runAndRecord([
  "question",
  "--id",
  "AQ-resource-demo",
  "--actor",
  callerActor,
  "--resource",
  "setup-watcher:ProjectDD/DDSetup",
  "--question",
  "I need to run DD setup validation. Are you currently holding the DD setup watcher?",
  "--expect",
  "Answer with active setup constraints or clear-to-run evidence."
]);
await runAndRecord(["done-check", "--actor", callerActor], 2);
await runAndRecord(["inbox", "--actor", ownerActor]);
await runAndRecord([
  "respond",
  "AQ-resource-demo",
  "--actor",
  ownerActor,
  "--status",
  "answered",
  "--evidence",
  "DD setup watcher is idle; safe to run validation now."
]);
await runAndRecord(["done-check", "--actor", callerActor]);

const actual = `${transcript.join("\n\n")}\n`
  .replaceAll(ownerActor, "<owner>")
  .replaceAll(callerActor, "<caller>");
const expected = await readFile(
  new URL("../fixtures/demo/resource/expected.md", import.meta.url),
  "utf8"
);

if (normalizeNewlines(actual).trim() !== normalizeNewlines(expected).trim()) {
  throw new Error(`Resource demo transcript drifted.\n\nActual:\n${actual}`);
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
