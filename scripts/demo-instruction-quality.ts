import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandRuntime } from "../packages/cli/src/main.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-instruction-demo-"));
const workspace = path.join(tempRoot, "workspace");
const stateRoot = path.join(tempRoot, "state");
await mkdir(workspace, { recursive: true });

const runtime: CommandRuntime = {
  cwd: workspace,
  env: { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
  now: () => "2026-05-18T00:00:00.000Z"
};

const transcript: string[] = ["# AgentQ Instruction Quality Transcript", "", "```text"];

const owner = await runAndRecord([
  "enter",
  "--as",
  "codex",
  "--session",
  "protocol-owner",
  "--paths",
  "src/protocol.ts",
  "--responsibility",
  "protocol schema"
]);
const ownerActor = owner.stdout.trim().replace(/ registered$/, "");

const target = await runAndRecord([
  "enter",
  "--as",
  "copilot-cli",
  "--session",
  "instruction-target",
  "--paths",
  ".",
  "--responsibility",
  "copilot session"
]);
const targetActor = target.stdout.trim().replace(/ registered$/, "");

await runAndRecord(["scope-check", "--actor", targetActor], 2);
await runAndRecord([
  "enter",
  "--actor",
  targetActor,
  "--paths",
  "src/consumer.ts",
  "--responsibility",
  "protocol consumer change",
  "--summary",
  "Modify protocol consumer safely"
]);
await runAndRecord(["inbox", "--actor", targetActor]);
await runAndRecord(["work", "status", "--actor", targetActor]);
await runAndRecord([
  "work",
  "start",
  "--id",
  "AW-instruction-quality",
  "--actor",
  targetActor,
  "--title",
  "Modify protocol consumer safely",
  "--path",
  "src/consumer.ts"
]);
await runAndRecord([
  "owners",
  "--actor",
  targetActor,
  "--path",
  "src/protocol.ts"
]);
await runAndRecord([
  "question",
  "--id",
  "AQ-instruction-path",
  "--actor",
  targetActor,
  "--path",
  "src/protocol.ts",
  "--question",
  "I need to update the protocol consumer. What protocol fields must I preserve?",
  "--expect",
  "Answer with active protocol edits or clear-to-edit evidence."
]);
await runAndRecord(["done-check", "--actor", targetActor], 2);
await runAndRecord(["inbox", "--actor", ownerActor]);
await runAndRecord([
  "respond",
  "AQ-instruction-path",
  "--actor",
  ownerActor,
  "--status",
  "answered",
  "--evidence",
  "Preserve routingEvidence and keep RequiredRequest routing evidence visible."
]);
await runAndRecord([
  "work",
  "evidence",
  "--actor",
  targetActor,
  "--evidence",
  "Owner answered protocol field contract; consumer update can preserve routingEvidence."
]);
await runAndRecord([
  "work",
  "close",
  "--actor",
  targetActor,
  "--summary",
  "Protocol consumer update is unblocked by owner evidence."
]);
await runAndRecord(["done-check", "--actor", targetActor]);

transcript.push("```");

const actual = `${transcript.join("\n")}\n`
  .replaceAll(ownerActor, "<owner>")
  .replaceAll(targetActor, "<target>");
const expected = await readFile(
  new URL("../fixtures/instruction-quality/expected.md", import.meta.url),
  "utf8"
);

if (normalizeNewlines(actual).trim() !== normalizeNewlines(expected).trim()) {
  throw new Error(`Instruction transcript drifted.\n\nActual:\n${actual}`);
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
