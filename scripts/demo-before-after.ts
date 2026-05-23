import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandRuntime } from "../packages/cli/src/main.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-before-after-"));
const beforeWorkspace = path.join(tempRoot, "before-workspace");
const afterWorkspace = path.join(tempRoot, "after-workspace");
const stateRoot = path.join(tempRoot, "state");

await mkdir(path.join(beforeWorkspace, "src"), { recursive: true });
await mkdir(path.join(afterWorkspace, "src"), { recursive: true });

const beforeProtocol = path.join(beforeWorkspace, "src", "protocol.ts");
const afterProtocol = path.join(afterWorkspace, "src", "protocol.ts");
await writeFile(beforeProtocol, initialProtocol(), "utf8");
await writeFile(afterProtocol, initialProtocol(), "utf8");

const runtime: CommandRuntime = {
  cwd: afterWorkspace,
  env: { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
  now: () => "2026-05-18T00:00:00.000Z"
};

const transcript: string[] = ["# AgentQ Before/After Collision Demo", "", "```text"];

record("# BEFORE: no AgentQ handshake");
record("$ cat src/protocol.ts");
record((await readFile(beforeProtocol, "utf8")).trim());
record("$ codex writes protocol schema from its copy");
await writeFile(beforeProtocol, codexProtocol(), "utf8");
record("$ claude writes consumer field from a stale copy");
await writeFile(beforeProtocol, staleClaudeProtocol(), "utf8");
record("$ cat src/protocol.ts");
record((await readFile(beforeProtocol, "utf8")).trim());
record("lost: routingEvidence was overwritten by the stale write");

record("");
record("# AFTER: AgentQ handshake before touching the shared file");
const codex = await runAndRecord([
  "enter",
  "--as",
  "codex",
  "--session",
  "codex-after",
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
  "claude-after",
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
  "AQ-before-after",
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
await runAndRecord(["respond", "AQ-before-after", "--actor", codexActor, "--status", "answered", "--evidence", "I added routingEvidence; preserve it when adding consumerView."]);
await writeFile(afterProtocol, coordinatedProtocol(), "utf8");
record("$ cat src/protocol.ts");
record((await readFile(afterProtocol, "utf8")).trim());
await runAndRecord(["done-check", "--actor", claudeActor]);

transcript.push("```");

const actual = `${transcript.join("\n")}\n`
  .replaceAll(codexActor, "<codex>")
  .replaceAll(claudeActor, "<claude>");
const expected = await readFile(
  new URL("../fixtures/demo/before-after/expected.md", import.meta.url),
  "utf8"
);

if (normalizeNewlines(actual).trim() !== normalizeNewlines(expected).trim()) {
  throw new Error(`Before/after demo transcript drifted.\n\nActual:\n${actual}`);
}

function record(value: string): void {
  transcript.push(value);
}

async function runAndRecord(argv: readonly string[], expectedCode = 0) {
  record(`$ agentq ${argv.join(" ")}`);
  const result = await runCommand(argv, runtime);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output.length > 0) {
    record(output);
  }
  if (result.code !== expectedCode) {
    throw new Error(`Command failed: agentq ${argv.join(" ")}\n${output}`);
  }

  return result;
}

function initialProtocol(): string {
  return [
    "export interface ProtocolMessage {",
    "  id: string;",
    "}",
    ""
  ].join("\n");
}

function codexProtocol(): string {
  return [
    "export interface ProtocolMessage {",
    "  id: string;",
    "  routingEvidence: string[];",
    "}",
    ""
  ].join("\n");
}

function staleClaudeProtocol(): string {
  return [
    "export interface ProtocolMessage {",
    "  id: string;",
    "  consumerView: string;",
    "}",
    ""
  ].join("\n");
}

function coordinatedProtocol(): string {
  return [
    "export interface ProtocolMessage {",
    "  id: string;",
    "  routingEvidence: string[];",
    "  consumerView: string;",
    "}",
    ""
  ].join("\n");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
