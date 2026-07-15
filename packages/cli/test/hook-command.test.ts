import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectedHookEntry } from "../src/installer/hookConfig.js";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("Codex Windows hook command", () => {
  windowsIt("executes through supported Windows shells with exact argv and stdin", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-hook-command-"));
    const root = path.join(tempRoot, "$agentq hook's workspace");
    await mkdir(root);
    const entrypointPath = path.join(root, "capture hook.mjs");
    await writeFile(
      entrypointPath,
      [
        'import { writeFileSync } from "node:fs";',
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        "writeFileSync(",
        "  process.env.AGENTQ_HOOK_CAPTURE_PATH,",
        "  JSON.stringify({ argv: process.argv.slice(2), stdin: Buffer.concat(chunks).toString(\"utf8\") }),",
        '  "utf8"',
        ");"
      ].join("\n"),
      "utf8"
    );

    const handlerCommand = `"${process.execPath}" "${entrypointPath}"`;
    const cases = [
      {
        event: "SessionStart" as const,
        eventName: "session-start",
        payload: JSON.stringify({
          session_id: "session-a",
          cwd: root,
          hook_event_name: "SessionStart",
          source: "startup"
        })
      },
      {
        event: "PreToolUse" as const,
        eventName: "pre-tool-use",
        payload: JSON.stringify({
          session_id: "session-a",
          cwd: root,
          hook_event_name: "PreToolUse",
          tool_name: "apply_patch",
          tool_input: { command: "*** Begin Patch\n*** End Patch\n" }
        })
      }
    ];

    for (const shell of windowsShells()) {
      for (const testCase of cases) {
        const capturePath = path.join(root, `${shell.name}-${testCase.eventName}.json`);
        const commandWindows = windowsCommand(
          expectedHookEntry("codex", testCase.event, handlerCommand)
        );
        const stdout = execFileSync(
          shell.program,
          [...shell.args, commandWindows],
          {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, AGENTQ_HOOK_CAPTURE_PATH: capturePath },
            input: testCase.payload,
            stdio: ["pipe", "pipe", "pipe"]
          }
        );

        expect(stdout, `${shell.name} ${testCase.event}`).toBe("");
        await expect(readFile(capturePath, "utf8")).resolves.toBe(JSON.stringify({
          argv: ["hook", "codex", testCase.eventName],
          stdin: testCase.payload
        }));
      }
    }
  }, 20_000);
});

interface HookShell {
  readonly name: string;
  readonly program: string;
  readonly args: readonly string[];
}

function windowsShells(): readonly HookShell[] {
  const shells: HookShell[] = [
    {
      name: "pwsh",
      program: "pwsh",
      args: ["-NoProfile", "-NonInteractive", "-Command"]
    },
    {
      name: "windows-powershell",
      program: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command"]
    }
  ];
  const gitBash = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) {
    shells.push({
      name: "git-bash",
      program: gitBash,
      args: ["--noprofile", "--norc", "-c"]
    });
  }
  return shells;
}

function windowsCommand(entry: Record<string, unknown>): string {
  const hooks = entry.hooks;
  if (!Array.isArray(hooks) || typeof hooks[0] !== "object" || hooks[0] === null) {
    throw new Error("generated hook entry is missing its command handler");
  }
  const command = (hooks[0] as Record<string, unknown>).commandWindows;
  if (typeof command !== "string") {
    throw new Error("generated Codex hook entry is missing commandWindows");
  }
  return command;
}
