import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, type CommandRuntime } from "../packages/cli/src/main.js";

type ScenarioResult = {
  name: string;
  result: "pass";
  evidence: string[];
};

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-agent-eval-"));
const workspace = path.join(tempRoot, "workspace");
const stateRoot = path.join(tempRoot, "state");
await mkdir(workspace, { recursive: true });

const runtime: CommandRuntime = {
  cwd: workspace,
  env: { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot },
  now: () => "2026-05-18T00:00:00.000Z"
};

const commandLog: string[] = [];
const scenarios: ScenarioResult[] = [];

scenarios.push(await runRequiredPathHandshake());
scenarios.push(await runNonBlockingNote());
scenarios.push(runStaticTranscriptRules());

const actual = renderReport(scenarios);
const expected = await readFile(
  new URL("../fixtures/eval/agent-behavior/expected.md", import.meta.url),
  "utf8"
);

if (normalizeNewlines(actual).trim() !== normalizeNewlines(expected).trim()) {
  throw new Error(`Agent behavior eval report drifted.\n\nActual:\n${actual}`);
}

async function runRequiredPathHandshake(): Promise<ScenarioResult> {
  const owner = await runAndRecord([
    "enter",
    "--as",
    "codex",
    "--session",
    "eval-protocol-owner",
    "--paths",
    "src/protocol.ts",
    "--responsibility",
    "protocol schema"
  ]);
  const ownerActor = actorFromEnter(owner.stdout);

  const target = await runAndRecord([
    "enter",
    "--as",
    "claude-code",
    "--session",
    "eval-consumer-target",
    "--paths",
    "src/consumer.ts",
    "--responsibility",
    "protocol consumer"
  ]);
  const targetActor = actorFromEnter(target.stdout);

  const owners = await runAndRecord([
    "owners",
    "--actor",
    targetActor,
    "--path",
    "src/protocol.ts"
  ]);
  assertIncludes(owners.stdout, ownerActor, "owners should report the active protocol owner");

  const question = await runAndRecord([
    "question",
    "--id",
    "AQ-eval-path",
    "--actor",
    targetActor,
    "--path",
    "src/protocol.ts",
    "--question",
    "What protocol fields must I preserve?",
    "--expect",
    "Answer with active protocol edits or clear-to-edit evidence."
  ]);
  assertIncludes(question.stdout, `AQ-eval-path routed to ${ownerActor}`, "question should route to owner");

  const pending = await runAndRecord(["done-check", "--actor", targetActor], 2);
  assertIncludes(pending.stderr, "outbound_pending: AQ-eval-path", "pending question should block done-check");

  const inbox = await runAndRecord(["inbox", "--actor", ownerActor]);
  assertIncludes(inbox.stdout, "respond: agentq respond AQ-eval-path", "owner inbox should show respond command");

  await runAndRecord([
    "respond",
    "AQ-eval-path",
    "--actor",
    ownerActor,
    "--status",
    "answered",
    "--evidence",
    "Preserve routingEvidence and RequiredRequest routing evidence fields."
  ]);

  const next = await runAndRecord(["next", "--actor", targetActor]);
  assertIncludes(next.stdout, "AQ-eval-path answered", "next should surface answered evidence");

  const done = await runAndRecord(["done-check", "--actor", targetActor]);
  assertIncludes(done.stdout, "ok: no required replies or active work remain open", "done-check should pass after answer");

  return {
    name: "required path handshake",
    result: "pass",
    evidence: [
      "owners found the active protocol owner before a shared path change",
      "required question blocked done-check while pending",
      "next surfaced the answered evidence before final done-check"
    ]
  };
}

async function runNonBlockingNote(): Promise<ScenarioResult> {
  const receiver = await runAndRecord([
    "enter",
    "--as",
    "codex",
    "--session",
    "eval-review-receiver",
    "--paths",
    "docs/review.md",
    "--responsibility",
    "review recipient"
  ]);
  const receiverActor = actorFromEnter(receiver.stdout);

  const sender = await runAndRecord([
    "enter",
    "--as",
    "copilot-cli",
    "--session",
    "eval-note-sender",
    "--paths",
    "docs/caller.md",
    "--responsibility",
    "advisory note sender"
  ]);
  const senderActor = actorFromEnter(sender.stdout);

  const note = await runAndRecord([
    "note",
    "--id",
    "AQ-eval-note",
    "--actor",
    senderActor,
    "--to",
    receiverActor,
    "--path",
    "docs/review.md",
    "--summary",
    "Advisory review context",
    "--note",
    "This is context only; no decision is required."
  ]);
  assertIncludes(note.stdout, `AQ-eval-note noted to ${receiverActor}`, "note should route without becoming required");

  const done = await runAndRecord(["done-check", "--actor", senderActor]);
  assertIncludes(done.stdout, "ok: no required replies or active work remain open", "note should not block sender done-check");

  const inbox = await runAndRecord(["inbox", "--actor", receiverActor]);
  assertIncludes(inbox.stdout, "kind: note", "receiver inbox should show note kind");
  assertIncludes(inbox.stdout, "ack:", "receiver inbox should show ack command");

  return {
    name: "non-blocking note",
    result: "pass",
    evidence: [
      "note reached the recipient inbox with an ack command",
      "sender done-check still passed because no decision was required"
    ]
  };
}

function runStaticTranscriptRules(): ScenarioResult {
  const goodFailures = evaluateTranscript(commandLog);
  if (goodFailures.length > 0) {
    throw new Error(`Good AgentQ transcript failed static rules:\n${goodFailures.join("\n")}`);
  }

  const badTranscript = [
    "agentq enter --actor <target> --paths src/consumer.ts --responsibility protocol-consumer",
    "agentq question --actor <target> --path src/protocol.ts --question Can I change this? --expect evidence",
    "agentq inbox",
    "agentq respond AQ-bad --actor <owner> --status answered --evidence ok"
  ];
  const badFailures = evaluateTranscript(badTranscript);
  assertIncludes(
    badFailures.join("\n"),
    "missing owner lookup before question on src/protocol.ts",
    "bad transcript should fail missing owner lookup"
  );
  assertIncludes(
    badFailures.join("\n"),
    "missing --actor on stateful command: agentq inbox",
    "bad transcript should fail implicit actor use"
  );
  assertIncludes(
    badFailures.join("\n"),
    "missing done-check before completion",
    "bad transcript should fail missing completion gate"
  );

  return {
    name: "static transcript rules",
    result: "pass",
    evidence: [
      "recorded good transcript passed command-sequence rules",
      "bad transcript failed missing owner lookup, missing --actor, and missing done-check"
    ]
  };
}

function evaluateTranscript(commands: readonly string[]): string[] {
  const failures: string[] = [];
  const ownerLookups = new Set<string>();
  let sawDoneCheck = false;

  for (const command of commands) {
    const tokens = command.split(/\s+/);
    const name = tokens[1];

    if (command.includes("agentq current")) {
      failures.push("forbidden implicit identity command: agentq current");
    }

    if (requiresExplicitActor(name, tokens) && !tokens.includes("--actor")) {
      failures.push(`missing --actor on stateful command: ${command}`);
    }

    if (name === "owners") {
      const actor = optionValue(tokens, "--actor");
      const pathValue = optionValue(tokens, "--path");
      if (actor && pathValue) {
        ownerLookups.add(`${actor}|${pathValue}`);
      }
    }

    if (name === "question" || name === "block") {
      const actor = optionValue(tokens, "--actor");
      const pathValue = optionValue(tokens, "--path");
      if (actor && pathValue && !ownerLookups.has(`${actor}|${pathValue}`)) {
        failures.push(`missing owner lookup before ${name} on ${pathValue}`);
      }
    }

    if (name === "done-check") {
      sawDoneCheck = true;
    }
  }

  if (!sawDoneCheck) {
    failures.push("missing done-check before completion");
  }

  return failures;
}

function requiresExplicitActor(name: string | undefined, tokens: readonly string[]): boolean {
  if (!name) {
    return false;
  }
  if (name === "enter" && tokens.includes("--as")) {
    return false;
  }
  return new Set([
    "owners",
    "work",
    "block",
    "question",
    "note",
    "inbox",
    "wake",
    "respond",
    "supersede",
    "follow-up",
    "accept-blocked",
    "scope-check",
    "done-check",
    "next"
  ]).has(name);
}

function optionValue(tokens: readonly string[], option: string): string | undefined {
  const index = tokens.indexOf(option);
  if (index < 0) {
    return undefined;
  }
  return tokens[index + 1];
}

async function runAndRecord(argv: readonly string[], expectedCode = 0) {
  commandLog.push(`agentq ${argv.join(" ")}`);
  const result = await runCommand(argv, runtime);
  if (result.code !== expectedCode) {
    throw new Error(`Command failed: agentq ${argv.join(" ")}\n${result.stdout}${result.stderr}`);
  }

  return result;
}

function renderReport(results: readonly ScenarioResult[]): string {
  const lines = [
    "# AgentQ Agent Behavior Eval",
    "",
    "Generated by `scripts/eval-agent-behavior.ts` in a temporary workspace and temporary AgentQ state root.",
    "",
    "| Scenario | Result | Evidence |",
    "|----------|--------|----------|"
  ];

  for (const result of results) {
    lines.push(`| ${result.name} | ${result.result} | ${result.evidence.join("<br>")} |`);
  }

  lines.push(
    "",
    "This eval verifies protocol behavior and transcript shape. It is not a model benchmark; real Codex, Claude Code, and Copilot sessions still need surface-specific transcript captures."
  );

  return `${lines.join("\n")}\n`;
}

function actorFromEnter(stdout: string): string {
  return stdout.trim().replace(/ registered$/, "");
}

function assertIncludes(value: string, expected: string, message: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${message}\nExpected to include: ${expected}\nActual:\n${value}`);
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
