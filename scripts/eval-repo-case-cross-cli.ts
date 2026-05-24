import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type Agent = "codex" | "claude" | "copilot";
type Variant = "none" | "legacy" | "queue-stack";

type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

type RunResult = {
  readonly agent: Agent;
  readonly variant: Variant;
  readonly root: string;
  readonly visible: CommandResult;
  readonly hidden: readonly string[];
  readonly agentq?: {
    readonly receiver: string;
    readonly inbox: string;
    readonly workStatus: string;
    readonly doneCheck: CommandResult;
  };
  readonly cli: CommandResult;
  readonly changedFiles: string;
};

const agents = parseList<Agent>("--agents", ["codex", "claude", "copilot"]);
const variants = parseList<Variant>("--variants", ["none", "legacy", "queue-stack"]);

const results: RunResult[] = [];
for (const agent of agents) {
  for (const variant of variants) {
    results.push(runCase(agent, variant));
  }
}

const resultPath = path.join(os.tmpdir(), `agentq-repo-case-cross-cli-${Date.now()}.json`);
writeFileSync(resultPath, JSON.stringify(results, null, 2), "utf8");

console.log(JSON.stringify({
  resultPath,
  summary: results.map((result) => ({
    agent: result.agent,
    variant: result.variant,
    root: result.root,
    cliStatus: result.cli.status,
    visibleStatus: result.visible.status,
    visible: result.visible.stdout.trim() || result.visible.stderr.trim(),
    hidden: result.hidden,
    agentqDoneStatus: result.agentq?.doneCheck.status,
    agentqDone: result.agentq?.doneCheck.stdout.trim() || result.agentq?.doneCheck.stderr.trim()
  }))
}, null, 2));

function runCase(agent: Agent, variant: Variant): RunResult {
  const root = mkdtempSync(path.join(os.tmpdir(), `agentq-repo-case-${agent}-${variant}-`));
  writeRepoCaseFixture(root);
  run("git", ["init", "-q"], root);
  run("git", ["config", "user.email", "agentq@example.invalid"], root);
  run("git", ["config", "user.name", "AgentQ Eval"], root);
  run("git", ["add", "."], root);
  run("git", ["commit", "-m", "fixture"], root);

  const agentq = variant === "none" ? undefined : setupAgentQ(root, agent, variant);
  const inboxSection = agentq === undefined
    ? ""
    : [
        "AgentQ inbox output:",
        "```text",
        agentq.inbox.trimEnd(),
        "```",
        "",
        "Resolve required AgentQ items before editing. Treat the owner answer as a code ownership contract.",
        "After editing, record useful work evidence, close active work, and run done-check."
      ].join("\n");

  const prompt = [
    "You are editing a temporary ProjectDD-style repo-case fixture.",
    "",
    inboxSection,
    "Task: implement damage floater hit position support so `node tests/visible.test.js` passes.",
    "",
    "Repo-case context:",
    "- This fixture mirrors the ProjectDD DamageContext / DamageApplied / DDAttackDamage / DDProjectileSystem / DDUnitView ownership issue.",
    "- Visible tests allow multiple designs, including plausible local fixes.",
    "- Prefer the design that best matches the available ownership contract.",
    "",
    "Constraints:",
    "- Do not edit tests.",
    "- Keep DamageApplied as a replayable damage result fact unless you have a direct ownership contract saying otherwise.",
    "- Use `rtk` for shell commands.",
    "- After editing, run `node tests/visible.test.js` and report changed files plus result.",
    agentq === undefined ? "" : `- Your AgentQ actor id is ${agentq.receiver}. Use it explicitly for AgentQ commands.`
  ].filter(Boolean).join("\n");

  const cli = runAgent(agent, root, prompt);
  const visible = run("node", [path.join(root, "tests", "visible.test.js")], root);
  const hidden = hiddenChecks(root);
  const workStatus = agentq === undefined ? undefined : runAgentQ(["work", "status", "--actor", agentq.receiver], root).stdout;
  const doneCheck = agentq === undefined ? undefined : runAgentQ(["done-check", "--actor", agentq.receiver], root);

  return {
    agent,
    variant,
    root,
    visible,
    hidden,
    agentq: agentq === undefined || workStatus === undefined || doneCheck === undefined
      ? undefined
      : {
          receiver: agentq.receiver,
          inbox: agentq.inbox,
          workStatus,
          doneCheck
        },
    cli,
    changedFiles: run("git", ["diff", "--name-only"], root).stdout
  };
}

function writeRepoCaseFixture(root: string): void {
  const dirs = [
    "ProjectDD/DD.Shared/Common/Battle/Interactions",
    "ProjectDD/DD.Shared/Common/Battle/Components",
    "ProjectDD/DDUnity/Assets/Game/Views",
    "tests"
  ];
  for (const dir of dirs) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }

  writeFileSync(path.join(root, "ProjectDD/DD.Shared/Common/Battle/Interactions/DamageContext.cs"), `
namespace DD.Battle.Interactions
{
    public struct DamageContext
    {
        public UnitHandle Source { get; set; }
        public UnitHandle Target { get; set; }
        public int Power { get; set; }
        public int Amount { get; set; }
        public bool IsCritical { get; set; }
        public bool Cancelled { get; set; }
        public int HpBefore { get; set; }
        public int HpAfter { get; set; }
        public bool Killed { get; set; }
    }
}
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "ProjectDD/DD.Shared/Common/Battle/Interactions/DamageApplied.cs"), `
namespace DD.Battle.Interactions
{
    public readonly struct DamageApplied
    {
        public DamageApplied(UnitHandle source, UnitHandle target, int amount, int hpBefore, int hpAfter, bool isCritical, bool killed)
        {
            Source = source;
            Target = target;
            Amount = amount;
            HpBefore = hpBefore;
            HpAfter = hpAfter;
            IsCritical = isCritical;
            Killed = killed;
        }

        public UnitHandle Source { get; }
        public UnitHandle Target { get; }
        public int Amount { get; }
        public int HpBefore { get; }
        public int HpAfter { get; }
        public bool IsCritical { get; }
        public bool Killed { get; }
    }
}
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "ProjectDD/DD.Shared/Common/Battle/Components/DDAttackDamage.cs"), `
using DD.Battle.Interactions;

namespace DD.Battle.Components
{
    public sealed class DDAttackDamage
    {
        public void HandleActionMessage(DDUnit source, DDUnit target)
        {
            var damage = new DamageContext
            {
                Source = source.Handle,
                Target = target.Handle,
                Power = source.State.ATK,
            };

            _ = source.Interact(ref damage);
        }
    }
}
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "ProjectDD/DD.Shared/Common/Battle/Components/DDProjectileSystem.cs"), `
using DD.Battle.Interactions;

namespace DD.Battle.Components
{
    public sealed class DDProjectileSystem
    {
        private static void ApplyImpact(DDUnit projectile, DDUnit owner, DDUnit target)
        {
            var damage = new DamageContext
            {
                Source = owner.Handle,
                Target = target.Handle,
                Power = owner.State.ATK,
            };

            _ = projectile.Interact(ref damage);
        }
    }
}
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "ProjectDD/DDUnity/Assets/Game/Views/DDUnitView.cs"), `
using DD.Battle.Interactions;

namespace DD.Unity.Views
{
    public sealed class DDUnitView
    {
        public void HandleInteractionView(in DamageContext context, in DamageApplied applied)
        {
            PushDamageFloater(applied.Amount);
        }

        private void PushDamageFloater(int amount)
        {
        }
    }
}
`.trimStart(), "utf8");

  writeFileSync(path.join(root, "tests/visible.test.js"), `
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const context = read('ProjectDD/DD.Shared/Common/Battle/Interactions/DamageContext.cs');
const applied = read('ProjectDD/DD.Shared/Common/Battle/Interactions/DamageApplied.cs');
const attack = read('ProjectDD/DD.Shared/Common/Battle/Components/DDAttackDamage.cs');
const projectile = read('ProjectDD/DD.Shared/Common/Battle/Components/DDProjectileSystem.cs');
const view = read('ProjectDD/DDUnity/Assets/Game/Views/DDUnitView.cs');

assert(/HitPosition/.test(context) || /HitPosition/.test(applied), 'a hit position field must exist somewhere');
assert(/HitPosition\\s*=\\s*target\\.State\\.Position/.test(attack), 'direct attack must set target-based HitPosition');
assert(/HitPosition\\s*=\\s*projectile\\.BodyState\\.Position/.test(projectile), 'projectile impact must set projectile-based HitPosition');
assert(/PushDamageFloater\\s*\\(\\s*applied\\.Amount\\s*,\\s*(context|applied)\\.HitPosition\\s*\\)/.test(view), 'view must pass amount and a hit position to floater');

console.log('repo-case visible test passed');
`.trimStart(), "utf8");
}

function setupAgentQ(
  root: string,
  agent: Agent,
  variant: Exclude<Variant, "none">
): { readonly receiver: string; readonly inbox: string } {
  const slug = path.basename(root).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48);
  const receiverKind = agent === "claude" ? "claude-code" : agent === "copilot" ? "copilot-cli" : "codex";
  const receiverEnter = mustAgentQ([
    "enter",
    "--as",
    receiverKind,
    "--session",
    `${slug}-receiver-${shortId()}`,
    "--paths",
    "ProjectDD/DDUnity/Assets/Game/Views/DDUnitView.cs",
    "ProjectDD/DD.Shared/Common/Battle/Components/DDAttackDamage.cs",
    "ProjectDD/DD.Shared/Common/Battle/Components/DDProjectileSystem.cs",
    "--responsibility",
    "damage-floater-view-and-impact-anchors"
  ], root);
  const receiver = parseRegisteredActor(receiverEnter);

  mustAgentQ([
    "work",
    "start",
    "--actor",
    receiver,
    "--id",
    "AW-repo-case",
    "--title",
    "Implement-repo-case-damage-floater-hit-position",
    "--path",
    "ProjectDD/DDUnity/Assets/Game/Views/DDUnitView.cs",
    "--path",
    "ProjectDD/DD.Shared/Common/Battle/Components/DDAttackDamage.cs",
    "--path",
    "ProjectDD/DD.Shared/Common/Battle/Components/DDProjectileSystem.cs"
  ], root);

  const ownerEnter = mustAgentQ([
    "enter",
    "--as",
    "codex",
    "--session",
    `${slug}-owner-${shortId()}`,
    "--paths",
    "ProjectDD/DD.Shared/Common/Battle/Interactions/DamageContext.cs",
    "ProjectDD/DD.Shared/Common/Battle/Interactions/DamageApplied.cs",
    "--responsibility",
    "damage-context-applied-ownership"
  ], root);
  const owner = parseRegisteredActor(ownerEnter);

  mustAgentQ([
    "question",
    "--id",
    "AQ-repo-case-hit-position",
    "--actor",
    owner,
    "--to",
    receiver,
    "--path",
    "ProjectDD/DDUnity/Assets/Game/Views/DDUnitView.cs",
    "--summary",
    "RepoCaseDamageHitPositionOwnership",
    "--question",
    "Where_should_damage_floater_hit_position_live_for_ProjectDD?",
    "--pass",
    "Add_nullable_DamageContext.HitPosition;do_not_add_HitPosition_or_position_to_DamageApplied;DDAttackDamage_sets_target.State.Position_plus_target.HitHeight;DDProjectileSystem_sets_projectile.BodyState.Position;DDUnitView_uses_context.HitPosition_and_applied.Amount;generated_view_handlers_receive_context_plus_applied"
  ], root);

  const env = variant === "legacy" ? { AGENTQ_QUEUE_STACK_UX: "0" } : undefined;
  const inbox = runAgentQ(["inbox", "--actor", receiver], root, env).stdout;
  return { receiver, inbox };
}

function hiddenChecks(root: string): readonly string[] {
  const context = read(root, "ProjectDD/DD.Shared/Common/Battle/Interactions/DamageContext.cs");
  const applied = read(root, "ProjectDD/DD.Shared/Common/Battle/Interactions/DamageApplied.cs");
  const attack = read(root, "ProjectDD/DD.Shared/Common/Battle/Components/DDAttackDamage.cs");
  const projectile = read(root, "ProjectDD/DD.Shared/Common/Battle/Components/DDProjectileSystem.cs");
  const view = read(root, "ProjectDD/DDUnity/Assets/Game/Views/DDUnitView.cs");
  const failures: string[] = [];

  if (!/SLVector3\?\s+HitPosition|HitPosition\s*\{\s*get;\s*set;\s*\}/.test(context)) {
    failures.push("FAIL: DamageContext does not own HitPosition");
  }
  if (/HitPosition|hitPosition|Position/.test(stripTypeNames(applied))) {
    failures.push("FAIL: DamageApplied contains position-like data");
  }
  if (!/HitPosition\s*=\s*target\.State\.Position\s*\+.*HitHeight/s.test(attack)) {
    failures.push("FAIL: DDAttackDamage does not set target hit-height HitPosition");
  }
  if (!/HitPosition\s*=\s*projectile\.BodyState\.Position/.test(projectile)) {
    failures.push("FAIL: DDProjectileSystem does not set projectile BodyState HitPosition");
  }
  if (!/PushDamageFloater\s*\(\s*applied\.Amount\s*,\s*context\.HitPosition\s*\)/.test(view)) {
    failures.push("FAIL: DDUnitView does not pass context.HitPosition with applied.Amount");
  }

  return failures.length === 0 ? ["PASS"] : failures;
}

function runAgent(agent: Agent, cwd: string, prompt: string): CommandResult {
  const outputPath = path.join(cwd, `${agent}-output.txt`);
  if (agent === "codex") {
    return run(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-C",
        cwd,
        "-o",
        outputPath,
        "-"
      ],
      cwd,
      prompt,
      360_000
    );
  }

  if (agent === "claude") {
    return run(
      "claude",
      [
        "-p",
        prompt,
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions"
      ],
      cwd,
      undefined,
      360_000
    );
  }

  return run(
    "copilot",
    [
      "-p",
      prompt,
      "-C",
      cwd,
      "--allow-all",
      "--no-custom-instructions",
      "--experimental",
      "--silent",
      "--stream",
      "off"
    ],
    cwd,
    undefined,
    360_000
  );
}

function read(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function stripTypeNames(value: string): string {
  return value.replace(/DamageApplied/g, "").replace(/UnitHandle/g, "");
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
    if (absolute !== undefined && existsSync(absolute)) return absolute;
    return `${command}.cmd`;
  }

  if (command === "claude") {
    const absolute = path.join(os.homedir(), ".local", "bin", "claude.exe");
    if (existsSync(absolute)) return absolute;
  }

  if (command === "copilot") {
    const absolute = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "copilot.exe");
    if (existsSync(absolute)) return absolute;
  }

  return command;
}

function quoteWindowsArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@\\=-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function parseList<T extends string>(flag: string, fallback: readonly T[]): readonly T[] {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  return (process.argv[index + 1] ?? "").split(",").filter(Boolean) as T[];
}

function shortId(): string {
  return Math.random().toString(16).slice(2, 8);
}
