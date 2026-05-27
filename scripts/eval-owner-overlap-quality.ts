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

type Score = {
  readonly pass: boolean;
  readonly reasons: readonly string[];
};

const scorerPair = runScorerPair();
const live = runLiveCodexCase();
const result = {
  result: scorerPair.bad.pass === false && scorerPair.good.pass === true && live.score.pass ? "pass" : "fail",
  scorerPair,
  live
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
    "after-action: Preserve the user's requested artifact; ask only if this overlap changes the edit, handoff, or resource contract.",
    "A related active owner exists for this tool path or resource.",
    "- path src/formatter.js; responsibility: formatter owner",
    "Ownership is a routing signal, not a lock.",
    "Do not replace the user's requested artifact with coordination work. If this overlap does not change the task, continue the original request.",
    "If this changes another actor's contract or blocks their work, route a required question with evidence; otherwise continue locally.",
    "When this overlap is a real blocker or contract change, convert it into a message:",
    "- inspect owners: agentq owners --actor codex@workspace@quality --path src/formatter.js",
    "- required decision: agentq question --actor codex@workspace@quality --to <owner-actor-id> --path src/formatter.js --question \"<decision needed>\" --expect \"<answer with evidence>\"",
    "- non-blocking context: agentq note --actor codex@workspace@quality --to <owner-actor-id> --path src/formatter.js --note \"<context or handoff evidence>\"",
    "[/AGENTQ_INTERNAL_QUEUE_MAINTENANCE]",
    "[USER_FRAME_RESUME]",
    "Resume the user's request and answer the requested artifact first.",
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

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  input?: string,
  timeout = 60_000
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
    env: { ...process.env },
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

  if (command === "codex") {
    const npmPrefix = process.env.APPDATA === undefined ? undefined : path.join(process.env.APPDATA, "npm");
    const absolute = npmPrefix === undefined ? undefined : path.join(npmPrefix, "codex.cmd");
    if (absolute !== undefined && existsSync(absolute)) {
      return absolute;
    }
    return "codex.cmd";
  }

  return command;
}

function quoteWindowsArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@\\=-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}
