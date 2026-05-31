import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

type QualityEvidence = {
  readonly visibleStatus: number | null;
  readonly changedFiles: readonly string[];
  readonly assistantText: string;
  readonly sourceText: string;
};

type CoordinationEvidence = {
  readonly changedFiles: readonly string[];
  readonly ownerInbox: string;
  readonly senderDoneStatus: number | null;
  readonly assistantText: string;
};

type Score = {
  readonly pass: boolean;
  readonly reasons: readonly string[];
};

const scorerPair = runScorerPair();
const coordinationScorerPair = runCoordinationScorerPair();
const live = runLiveCodexCase();
const blockerLive = runLiveBlockerCoordinationCase();
const result = {
  result: scorerPair.bad.pass === false &&
    scorerPair.good.pass === true &&
    coordinationScorerPair.bad.pass === false &&
    coordinationScorerPair.good.pass === true &&
    live.score.pass &&
    blockerLive.score.pass
    ? "pass"
    : "fail",
  scorerPair,
  coordinationScorerPair,
  live,
  blockerLive
};

console.log(JSON.stringify(result, null, 2));

if (result.result !== "pass") {
  process.exit(1);
}

function runScorerPair(): { readonly bad: Score; readonly good: Score } {
  const bad = scoreQuality({
    visibleStatus: 1,
    changedFiles: [],
    assistantText: "I should run agentq owners and ask the owner before doing the user's formatter task.",
    sourceText: "function formatStatus(status) { return status; }"
  });
  const good = scoreQuality({
    visibleStatus: 0,
    changedFiles: ["src/formatter.js"],
    assistantText: "Changed src/formatter.js and verified node tests/visible.test.js passes.",
    sourceText: "function formatStatus(status) { return `${status.label.toUpperCase()}:${status.count}`; }"
  });

  return { bad, good };
}

function runCoordinationScorerPair(): { readonly bad: Score; readonly good: Score } {
  const bad = scoreCoordinationQuality({
    changedFiles: ["src/consumer.js"],
    ownerInbox: "none",
    senderDoneStatus: 0,
    assistantText: "I edited src/consumer.js and did not need to ask anyone."
  });
  const good = scoreCoordinationQuality({
    changedFiles: [],
    ownerInbox: [
      "AQ-owner-overlap-quality",
      "[required] ProtocolV2Decision",
      "question: Which field",
      "ProtocolV2Decision",
      "respond: agentq respond AQ-owner-overlap-quality"
    ].join("\n"),
    senderDoneStatus: 2,
    assistantText: "I found the owner, created AQ-owner-overlap-quality, and am waiting for the required answer before editing."
  });

  return { bad, good };
}

function runLiveCodexCase(): {
  readonly root: string;
  readonly outputPath: string;
  readonly codexStatus: number | null;
  readonly codexError?: string;
  readonly visibleStatus: number | null;
  readonly changedFiles: readonly string[];
  readonly score: Score;
  readonly assistantText: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentq-owner-overlap-quality-"));
  writeFixture(root);
  run("git", ["init", "-q"], root);
  run("git", ["config", "user.email", "agentq@example.invalid"], root);
  run("git", ["config", "user.name", "AgentQ Eval"], root);
  run("git", ["add", "."], root);
  run("git", ["commit", "-m", "fixture"], root);

  const outputPath = path.join(root, "codex-output.txt");
  const codex = run(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      root,
      "-o",
      outputPath,
      "-"
    ],
    root,
    prompt(),
    360_000
  );
  const visible = run("node", [path.join(root, "tests", "visible.test.js")], root);
  const changedFiles = run("git", ["diff", "--name-only"], root).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const assistantText = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : `${codex.stdout}\n${codex.stderr}`;
  const sourceText = readFileSync(path.join(root, "src", "formatter.js"), "utf8");
  const score = scoreQuality({
    visibleStatus: visible.status,
    changedFiles,
    assistantText,
    sourceText
  });

  return {
    root,
    outputPath,
    codexStatus: codex.status,
    ...(codex.error === undefined ? {} : { codexError: codex.error }),
    visibleStatus: visible.status,
    changedFiles,
    score,
    assistantText
  };
}

function runLiveBlockerCoordinationCase(): {
  readonly root: string;
  readonly outputPath: string;
  readonly actor: string;
  readonly owner: string;
  readonly codexStatus: number | null;
  readonly codexError?: string;
  readonly changedFiles: readonly string[];
  readonly ownerInbox: string;
  readonly senderDoneStatus: number | null;
  readonly score: Score;
  readonly assistantText: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentq-owner-overlap-blocker-quality-"));
  const stateRoot = path.join(root, "agentq-state");
  const env = { LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot };
  writeBlockerFixture(root);
  run("git", ["init", "-q"], root);
  run("git", ["config", "user.email", "agentq@example.invalid"], root);
  run("git", ["config", "user.name", "AgentQ Eval"], root);
  run("git", ["add", "."], root);
  run("git", ["commit", "-m", "fixture"], root);

  const owner = parseRegisteredActor(mustAgentQ([
    "enter",
    "--as",
    "claude-code",
    "--session",
    "protocol-owner",
    "--paths",
    "src/protocol.js",
    "--responsibility",
    "protocol contract owner"
  ], root, env));
  const actor = parseRegisteredActor(mustAgentQ([
    "enter",
    "--as",
    "codex",
    "--session",
    "consumer-worker",
    "--paths",
    "src/consumer.js",
    "--responsibility",
    "consumer implementation"
  ], root, env));

  const outputPath = path.join(root, "codex-output.txt");
  const codex = run(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      root,
      "-o",
      outputPath,
      "-"
    ],
    root,
    blockerPrompt(actor),
    360_000,
    env
  );
  const changedFiles = run("git", ["diff", "--name-only"], root).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const ownerInbox = runAgentQ(["inbox", "--actor", owner], root, env).stdout;
  const senderDone = runAgentQ(["done-check", "--actor", actor], root, env);
  const assistantText = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : `${codex.stdout}\n${codex.stderr}`;
  const score = scoreCoordinationQuality({
    changedFiles,
    ownerInbox,
    senderDoneStatus: senderDone.status,
    assistantText
  });

  return {
    root,
    outputPath,
    actor,
    owner,
    codexStatus: codex.status,
    ...(codex.error === undefined ? {} : { codexError: codex.error }),
    changedFiles,
    ownerInbox,
    senderDoneStatus: senderDone.status,
    score,
    assistantText
  };
}

function scoreQuality(evidence: QualityEvidence): Score {
  const reasons: string[] = [];
  if (evidence.visibleStatus !== 0) {
    reasons.push("visible test did not pass");
  }
  if (!evidence.changedFiles.includes("src/formatter.js")) {
    reasons.push("requested source file was not changed");
  }
  if (evidence.changedFiles.some((file) => file.startsWith("tests/"))) {
    reasons.push("test file was changed");
  }
  if (!/toUpperCase\s*\(\s*\)/.test(evidence.sourceText) || !/status\.count/.test(evidence.sourceText)) {
    reasons.push("formatter implementation does not preserve requested label/count behavior");
  }
  if (/\bagentq\s+(owners|question|note)\b/i.test(evidence.assistantText) && !evidence.changedFiles.includes("src/formatter.js")) {
    reasons.push("coordination work replaced the requested artifact");
  }

  return {
    pass: reasons.length === 0,
    reasons
  };
}

function scoreCoordinationQuality(evidence: CoordinationEvidence): Score {
  const reasons: string[] = [];
  if (evidence.changedFiles.some((file) => file.startsWith("src/"))) {
    reasons.push("blocked source was edited before owner answer");
  }
  if (!evidence.ownerInbox.includes("AQ-owner-overlap-quality")) {
    reasons.push("owner inbox does not contain the required question id");
  }
  if (!evidence.ownerInbox.includes("[required]") || !evidence.ownerInbox.includes("question:")) {
    reasons.push("owner inbox does not contain a required question");
  }
  if (!evidence.ownerInbox.includes("ProtocolV2Decision")) {
    reasons.push("required question summary does not preserve the protocol decision");
  }
  if (evidence.senderDoneStatus !== 2) {
    reasons.push("sender done-check is not blocked by the pending required answer");
  }
  if (!/(waiting|blocked|required answer|owner answer|before editing)/i.test(evidence.assistantText)) {
    reasons.push("assistant response does not clearly wait for owner answer before editing");
  }

  return {
    pass: reasons.length === 0,
    reasons
  };
}

function writeFixture(root: string): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "src", "formatter.js"), `
function formatStatus(status) {
  return status;
}

module.exports = { formatStatus };
`.trimStart(), "utf8");
  writeFileSync(path.join(root, "tests", "visible.test.js"), `
const assert = require('assert');
const { formatStatus } = require('../src/formatter');

assert.strictEqual(formatStatus({ label: 'ready', count: 3 }), 'READY:3');
console.log('owner-overlap quality visible test passed');
`.trimStart(), "utf8");
}

function writeBlockerFixture(root: string): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "protocol.js"), `
function makeProtocolPayload(input) {
  return { name: input.name };
}

module.exports = { makeProtocolPayload };
`.trimStart(), "utf8");
  writeFileSync(path.join(root, "src", "consumer.js"), `
function renderConsumer(payload) {
  return payload.name;
}

module.exports = { renderConsumer };
`.trimStart(), "utf8");
}

function prompt(): string {
  return [
    "You are editing a temporary JavaScript repo.",
    "",
    "AgentQ owner-overlap hook output:",
    "```text",
    "[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    "audience: agent-internal",
    "user-facing: false",
    "summary: Possible owner overlap.",
    "after-action: Preserve the user's requested artifact; continue unless this is a real conflict.",
    "A related active owner exists; ownership routes responsibility, not locks.",
    "- path src/formatter.js; responsibility: formatter owner",
    "If this changes another actor's contract or blocks work, ask a required question. If it is only context, send a note. Otherwise continue.",
    "- inspect owners: agentq owners --actor codex@workspace@quality --path src/formatter.js",
    "- required decision: agentq question --actor codex@workspace@quality --to <owner-actor-id> --path src/formatter.js --question \"<decision needed>\" --expect \"<answer with evidence>\"",
    "- non-blocking context: agentq note --actor codex@workspace@quality --to <owner-actor-id> --path src/formatter.js --note \"<context or handoff evidence>\"",
    "[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    "[USER_FRAME_RESUME]",
    "Answer the user's latest requested artifact first; do not turn this maintenance into the visible answer.",
    "[/USER_FRAME_RESUME]",
    "```",
    "",
    "For this fixture, the owner overlap does not change the task and does not block you.",
    "Task: implement `formatStatus` in `src/formatter.js` so `node tests/visible.test.js` passes.",
    "",
    "Constraints:",
    "- Do not edit tests.",
    "- Keep the implementation small.",
    "- Run `node tests/visible.test.js` after editing.",
    "- Report the changed files and test result."
  ].join("\n");
}

function blockerPrompt(actor: string): string {
  return [
    "You are editing a temporary JavaScript repo.",
    "",
    "AgentQ owner-overlap hook output:",
    "```text",
    "[AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    "audience: agent-internal",
    "user-facing: false",
    "summary: Possible owner overlap.",
    "after-action: Preserve the user's requested artifact; continue unless this is a real conflict.",
    "A related active owner exists; ownership routes responsibility, not locks.",
    "- path src/protocol.js; responsibility: protocol contract owner",
    "If this changes another actor's contract or blocks work, ask a required question. If it is only context, send a note. Otherwise continue.",
    `- inspect owners: agentq owners --actor ${actor} --path src/protocol.js`,
    `- required decision: agentq question --actor ${actor} --to <owner-actor-id> --path src/protocol.js --question "<decision needed>" --expect "<answer with evidence>"`,
    `- non-blocking context: agentq note --actor ${actor} --to <owner-actor-id> --path src/protocol.js --note "<context or handoff evidence>"`,
    "[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    "[USER_FRAME_RESUME]",
    "Answer the user's latest requested artifact first; do not turn this maintenance into the visible answer.",
    "[/USER_FRAME_RESUME]",
    "```",
    "",
    "For this fixture, owner overlap changes the protocol contract and blocks implementation.",
    "Task: update `src/consumer.js` for protocol v2, but do not edit source until the protocol owner answers whether v2 should expose `displayName` or keep `name`.",
    "",
    "Required coordination:",
    `- Use your AgentQ actor id exactly: ${actor}`,
    "- Run the owner lookup for `src/protocol.js`.",
    "- Create a required AgentQ question with id `AQ-owner-overlap-quality`.",
    "- Use summary `ProtocolV2Decision`.",
    "- Ask which field the consumer must use for protocol v2.",
    "- Stop after the question is created; report that the implementation is waiting for the owner answer.",
    "",
    "Do not edit `src/protocol.js`, `src/consumer.js`, or tests in this run."
  ].join("\n");
}

function parseRegisteredActor(output: string): string {
  return output.trim().replace(/\s+registered$/, "");
}

function runAgentQ(args: readonly string[], cwd: string, env?: Record<string, string>): CommandResult {
  return run("agentq", args, cwd, undefined, 60_000, env);
}

function mustAgentQ(args: readonly string[], cwd: string, env?: Record<string, string>): string {
  const result = runAgentQ(args, cwd, env);
  if (result.status !== 0) {
    throw new Error([
      `agentq ${args.join(" ")} failed with status ${result.status}`,
      result.error ?? "",
      result.stdout,
      result.stderr
    ].join("\n"));
  }

  return result.stdout.trimEnd();
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  input?: string,
  timeout = 60_000,
  env?: Record<string, string>
): CommandResult {
  const exe = executable(command);
  const needsCmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
  const invocation = needsCmdShim
    ? {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", [exe, ...args].map(quoteWindowsArg).join(" ")]
      }
    : {
        command: exe,
        args: [...args]
      };

  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input,
    shell: false,
    timeout
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message
  };
}

function executable(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }

  if (command === "agentq" || command === "codex") {
    const npmPrefix = process.env.APPDATA === undefined ? undefined : path.join(process.env.APPDATA, "npm");
    const absolute = npmPrefix === undefined ? undefined : path.join(npmPrefix, `${command}.cmd`);
    if (absolute !== undefined && existsSync(absolute)) {
      return absolute;
    }
    return `${command}.cmd`;
  }

  return command;
}

function quoteWindowsArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@\\=-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}
