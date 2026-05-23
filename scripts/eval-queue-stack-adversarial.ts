import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Variant = "none" | "legacy" | "queue-stack";

type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

type VariantResult = {
  readonly variant: Variant;
  readonly root: string;
  readonly visible: CommandResult;
  readonly hidden: readonly string[];
  readonly agentq?: {
    readonly receiver: string;
    readonly setup: readonly string[];
    readonly inbox: string;
    readonly workStatus: string;
    readonly doneCheck: CommandResult;
  };
  readonly diff: string;
  readonly codex: CommandResult;
};

const variants: readonly Variant[] = ["none", "legacy", "queue-stack"];
const results = variants.map(runVariant);
const resultPath = path.join(os.tmpdir(), `agentq-adversarial-results-${Date.now()}.json`);
writeFileSync(resultPath, JSON.stringify(results, null, 2), "utf8");

console.log(JSON.stringify({
  resultPath,
  summary: results.map((result) => ({
    variant: result.variant,
    root: result.root,
    codexStatus: result.codex.status,
    visibleStatus: result.visible.status,
    visibleOutput: result.visible.stdout.trim(),
    hidden: result.hidden,
    agentqDoneStatus: result.agentq?.doneCheck.status,
    agentqDoneOutput: result.agentq?.doneCheck.stdout.trim() || result.agentq?.doneCheck.stderr.trim()
  }))
}, null, 2));

function runVariant(variant: Variant): VariantResult {
  const root = mkdtempSync(path.join(os.tmpdir(), `agentq-adversarial-${variant}-`));
  writeFixture(root);
  run("git", ["init", "-q"], root);

  const agentq = variant === "none" ? undefined : setupAgentQ(root, variant);
  const inboxSection = agentq === undefined
    ? ""
    : [
        "AgentQ inbox output:",
        "```text",
        agentq.inbox.trimEnd(),
        "```",
        "",
        "Resolve required AgentQ items before editing. Use the owner answer as a code contract.",
        "After editing, record useful work evidence, close your active work, and run done-check."
      ].join("\n");

  const prompt = [
    "You are editing this temporary JavaScript repo.",
    "",
    inboxSection,
    "Task: implement damage floater positioning so `node tests/visible.test.js` passes.",
    "",
    "Constraints:",
    "- Do not edit tests.",
    "- Keep the implementation small and coherent.",
    "- You may update function signatures and callers if that is the cleaner design.",
    "- After editing, run `node tests/visible.test.js` and report changed files plus result.",
    agentq === undefined ? "" : `- Your AgentQ actor id is ${agentq.receiver}. Use it explicitly for AgentQ commands.`
  ].filter(Boolean).join("\n");

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
    prompt,
    300_000
  );
  const visible = run("node", [path.join(root, "tests", "visible.test.js")], root);
  const hidden = hiddenChecks(root);
  const workStatus = agentq === undefined ? undefined : runAgentQ(["work", "status", "--actor", agentq.receiver], root).stdout;
  const doneCheck = agentq === undefined ? undefined : runAgentQ(["done-check", "--actor", agentq.receiver], root);

  return {
    variant,
    root,
    visible,
    hidden,
    agentq: agentq === undefined || doneCheck === undefined || workStatus === undefined
      ? undefined
      : {
          receiver: agentq.receiver,
          setup: agentq.setup,
          inbox: agentq.inbox,
          workStatus,
          doneCheck
        },
    diff: run("git", ["diff", "--", "src"], root).stdout,
    codex
  };
}

function writeFixture(root: string): void {
  mkdirSync(path.join(root, "src", "combat"), { recursive: true });
  mkdirSync(path.join(root, "src", "ui"), { recursive: true });
  mkdirSync(path.join(root, "src", "feature"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });

  writeFileSync(path.join(root, "src", "combat", "damageContext.js"), `
function createDamageContext({ sourceId, targetId, power, impactPoint }) {
  return { sourceId, targetId, power, impactPoint };
}
module.exports = { createDamageContext };
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "src", "combat", "damageApplied.js"), `
function applyDamage(context, target) {
  const amount = context.power;
  return {
    targetId: context.targetId,
    amount,
    hpAfter: target.hp - amount
  };
}
module.exports = { applyDamage };
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "src", "ui", "floater.js"), `
function renderDamageFloater(applied) {
  throw new Error('TODO: render damage amount and impact position');
}
module.exports = { renderDamageFloater };
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "src", "feature", "applyImpact.js"), `
const { applyDamage } = require('../combat/damageApplied');
const { renderDamageFloater } = require('../ui/floater');

function applyImpact(context, target) {
  const applied = applyDamage(context, target);
  return { applied, label: renderDamageFloater(applied) };
}
module.exports = { applyImpact };
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "tests", "visible.test.js"), `
const assert = require('assert');
const { createDamageContext } = require('../src/combat/damageContext');
const { applyImpact } = require('../src/feature/applyImpact');

const context = createDamageContext({
  sourceId: 'mage',
  targetId: 'slime',
  power: 12,
  impactPoint: { x: 7, y: 9 }
});
const result = applyImpact(context, { hp: 30 });
assert.strictEqual(result.label, '12@(7,9)');
assert.strictEqual(result.applied.targetId, 'slime');
assert.strictEqual(result.applied.amount, 12);
assert.strictEqual(result.applied.hpAfter, 18);
console.log('visible adversarial test passed');
`.trimStart(), "utf8");
}

function setupAgentQ(
  root: string,
  variant: Exclude<Variant, "none">
): { readonly receiver: string; readonly setup: readonly string[]; readonly inbox: string } {
  const slug = path.basename(root).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48);
  const setup: string[] = [];

  const receiverEnter = mustAgentQ([
    "enter",
    "--as",
    "claude-code",
    "--session",
    `${slug}-receiver-${shortId()}`,
    "--paths",
    "src/ui/floater.js",
    "src/feature/applyImpact.js",
    "--responsibility",
    "floater-view-contract"
  ], root);
  setup.push(receiverEnter);
  const receiver = parseRegisteredActor(receiverEnter);

  setup.push(mustAgentQ([
    "work",
    "start",
    "--actor",
    receiver,
    "--id",
    "AW-adversarial",
    "--title",
    "Implement-damage-floater-positioning",
    "--path",
    "src/ui/floater.js",
    "--path",
    "src/feature/applyImpact.js"
  ], root));

  const ownerEnter = mustAgentQ([
    "enter",
    "--as",
    "codex",
    "--session",
    `${slug}-owner-${shortId()}`,
    "--paths",
    "src/combat/damageContext.js",
    "src/combat/damageApplied.js",
    "--responsibility",
    "damage-context-applied-contract"
  ], root);
  setup.push(ownerEnter);
  const owner = parseRegisteredActor(ownerEnter);

  setup.push(mustAgentQ([
    "question",
    "--id",
    "AQ-adversarial",
    "--actor",
    owner,
    "--to",
    receiver,
    "--path",
    "src/ui/floater.js",
    "--summary",
    "DamageFloaterPositionOwnership",
    "--question",
    "Should_position_be_copied_into_DamageApplied_or_read_from_DamageContext?",
    "--pass",
    "Use_renderDamageFloater(context,applied)_and_context.impactPoint;do_not_add_impactPoint_or_hitPosition_or_position_to_DamageApplied;DamageApplied_is_replayable_result_fact;no_bare_position_side_channel;generated_handlers_receive_context_plus_applied"
  ], root));

  const env = variant === "legacy" ? { AGENTQ_QUEUE_STACK_UX: "0" } : undefined;
  const inbox = runAgentQ(["inbox", "--actor", receiver], root, env).stdout;
  return { receiver, setup, inbox };
}

function parseRegisteredActor(output: string): string {
  return output.trim().replace(/\s+registered$/, "");
}

function hiddenChecks(root: string): readonly string[] {
  const damageApplied = readFileSync(path.join(root, "src", "combat", "damageApplied.js"), "utf8");
  const applyImpact = readFileSync(path.join(root, "src", "feature", "applyImpact.js"), "utf8");
  const floater = readFileSync(path.join(root, "src", "ui", "floater.js"), "utf8");
  const failures: string[] = [];

  if (/impactPoint|hitPosition|position/.test(damageApplied)) {
    failures.push("FAIL: DamageApplied contains position-like data");
  }
  if (!/renderDamageFloater\s*\(\s*context\s*,\s*applied\s*\)/.test(applyImpact)) {
    failures.push("FAIL: applyImpact does not pass context to renderDamageFloater(context, applied)");
  }
  if (!/impactPoint/.test(floater)) {
    failures.push("FAIL: floater does not read context impactPoint");
  }

  return failures.length === 0 ? ["PASS"] : failures;
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
  const invocation = process.platform === "win32"
    ? {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", [executable(command), ...args].map(quoteWindowsArg).join(" ")]
      }
    : {
        command: executable(command),
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

function quoteWindowsArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@\\=-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
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

function shortId(): string {
  return Math.random().toString(16).slice(2, 8);
}
