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
scenarios.push(await runQueueStackAbFixture());
scenarios.push(runStaticTranscriptRules());
scenarios.push(await runCrossCliFixtureCoverage());

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
  assertIncludes(pending.stderr, "outbound required reply: What protocol fields must I preserve?", "pending question should block done-check");

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
  assertIncludes(inbox.stdout, "[optional] Advisory review context", "receiver inbox should show optional note");
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

async function runQueueStackAbFixture(): Promise<ScenarioResult> {
  const receiver = await runAndRecord([
    "enter",
    "--as",
    "claude-code",
    "--session",
    "eval-queue-stack-receiver",
    "--paths",
    "src/runtime/eventBus.ts",
    "--responsibility",
    "event bus owner"
  ]);
  const receiverActor = actorFromEnter(receiver.stdout);

  const sender = await runAndRecord([
    "enter",
    "--as",
    "codex",
    "--session",
    "eval-queue-stack-sender",
    "--paths",
    "src/ui/statusPanel.ts",
    "--responsibility",
    "status panel view"
  ]);
  const senderActor = actorFromEnter(sender.stdout);

  await runAndRecord([
    "work",
    "start",
    "--actor",
    receiverActor,
    "--id",
    "AW-eval-queue-stack",
    "--title",
    "Repair event bus ownership",
    "--path",
    "src/runtime/eventBus.ts"
  ]);
  const owners = await runAndRecord([
    "owners",
    "--actor",
    senderActor,
    "--path",
    "src/runtime/eventBus.ts"
  ]);
  assertIncludes(owners.stdout, receiverActor, "queue/stack sender should find receiver before asking");
  await runAndRecord([
    "question",
    "--id",
    "AQ-eval-queue-stack",
    "--actor",
    senderActor,
    "--to",
    receiverActor,
    "--path",
    "src/runtime/eventBus.ts",
    "--question",
    "Can statusPanel read badge state from eventBus?",
    "--expect",
    "Answer with the owning source and safe read surface."
  ]);

  const enhanced = await runAndRecord(["inbox", "--actor", receiverActor]);
  assertIncludes(enhanced.stdout, "Resolve queue for", "enhanced inbox should name the resolve queue");
  assertIncludes(enhanced.stdout, "Return stack:", "enhanced inbox should show where to return after answering");
  assertIncludes(enhanced.stdout, "why: required reply blocks done-check", "enhanced inbox should explain required pressure");
  assertIncludes(enhanced.stdout, "related: current stack path overlap", "enhanced inbox should explain relation to work");

  const legacy = await runCommand(["inbox", "--actor", receiverActor], {
    ...runtime,
    env: { ...runtime.env, AGENTQ_QUEUE_STACK_UX: "0" }
  });
  if (legacy.code !== 0) {
    throw new Error(`Legacy inbox probe failed:\n${legacy.stdout}${legacy.stderr}`);
  }
  assertIncludes(legacy.stdout, "AQ-eval-queue-stack\n  kind: question", "legacy inbox should stay available for A/B review");

  const manualFixture = await readFile(
    new URL("../fixtures/eval/agent-behavior/queue-stack-ab.md", import.meta.url),
    "utf8"
  );
  assertIncludes(manualFixture, "Variant A", "manual A/B fixture should contain the legacy prompt");
  assertIncludes(manualFixture, "Variant B", "manual A/B fixture should contain the queue-stack prompt");
  assertIncludes(manualFixture, "AGENTQ_QUEUE_STACK_UX=0", "manual A/B fixture should name the off switch");

  return {
    name: "queue-stack A/B fixture",
    result: "pass",
    evidence: [
      "enhanced inbox injected resolve queue, return stack, required pressure, and relation hints",
      "legacy inbox remains reachable with AGENTQ_QUEUE_STACK_UX=0 for manual answer-quality comparison",
      "manual A/B fixture is present for user-scored transcript review"
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

async function runCrossCliFixtureCoverage(): Promise<ScenarioResult> {
  const inboxProbe = await readFile(
    new URL("../fixtures/cross-cli/2026-05-23-inbox-probe.md", import.meta.url),
    "utf8"
  );
  const copilotHookProbe = await readFile(
    new URL("../fixtures/cross-cli/2026-05-23-copilot-hook-surface.md", import.meta.url),
    "utf8"
  );

  assertIncludes(inboxProbe, "temporary `LOCALAPPDATA` store", "cross-cli inbox probe should be non-polluting");
  assertIncludes(inboxProbe, "agentq question --actor $sender --to $claude", "cross-cli inbox probe should ask Claude");
  assertIncludes(inboxProbe, "agentq question --actor $sender --to $copilot", "cross-cli inbox probe should ask Copilot");
  assertIncludes(inboxProbe, "agentq done-check --actor claude-code@", "Claude fixture should verify done-check");
  assertIncludes(inboxProbe, "agentq done-check --actor copilot-cli@", "Copilot fixture should verify done-check");
  assertIncludes(inboxProbe, "pending inbox: 0", "cross-cli inbox probe should end with no pending inbox");
  assertIncludes(inboxProbe, "open work: 0", "cross-cli inbox probe should end with no open work");

  assertIncludes(
    copilotHookProbe,
    "GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS",
    "Copilot fixture should document prompt-mode hook opt-in"
  );
  assertIncludes(copilotHookProbe, "actors: 0", "Copilot fixture should include negative hook-load evidence");
  assertIncludes(copilotHookProbe, "pre-tool", "Copilot fixture should include positive pre-tool hook evidence");
  assertIncludes(copilotHookProbe, "stop", "Copilot fixture should include positive stop hook evidence");

  return {
    name: "manual cross-cli fixture coverage",
    result: "pass",
    evidence: [
      "Claude and Copilot inbox probes include explicit actor done-check evidence",
      "Copilot hook fixture preserves negative and opt-in positive hook-load evidence"
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
