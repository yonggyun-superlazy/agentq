import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand, type CommandResult, type CommandRuntime } from "../src/main.js";

describe("project-local doctor", () => {
  it("reports missing, installed, and tampered boundaries without writing", async () => {
    const fixture = await createFixture();
    const beforeMissing = await snapshot(fixture.root);
    const missing = resultJson(await runCommand(["doctor"], fixture.runtime));
    expect(codes(missing)).toEqual(expect.arrayContaining([
      "codex_hooks_missing",
      "codex_feature_missing",
      "claude_hooks_missing",
      "codex_project_trust_unverified",
      "codex_handler_trust_unverified"
    ]));
    expect(await snapshot(fixture.root)).toEqual(beforeMissing);

    await runCommand(["install", "--yes"], fixture.runtime);
    const beforeInstalled = await snapshot(fixture.root);
    const installed = resultJson(await runCommand(["doctor"], fixture.runtime));
    expect(codes(installed)).toEqual(expect.arrayContaining([
      "codex_hooks_ok",
      "codex_feature_enabled",
      "claude_hooks_ok",
      "codex_project_trust_unverified",
      "codex_handler_trust_unverified"
    ]));
    expect(await snapshot(fixture.root)).toEqual(beforeInstalled);

    const hooksPath = path.join(fixture.workspace, ".codex", "hooks.json");
    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    hooks.hooks.PreToolUse[0].matcher = "Bash";
    await import("node:fs/promises").then(async ({ writeFile }) => {
      await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
    });
    const beforeTampered = await snapshot(fixture.root);
    const tampered = resultJson(await runCommand(["doctor"], fixture.runtime));
    expect(codes(tampered)).toContain("codex_hooks_mismatch");
    expect(await snapshot(fixture.root)).toEqual(beforeTampered);
  });

  it("rejects invalid TOML instead of reporting an enabled feature", async () => {
    const fixture = await createFixture();
    const configPath = path.join(fixture.workspace, ".codex", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await import("node:fs/promises").then(async ({ writeFile }) => {
      await writeFile(configPath, "[features]\nhooks = true\ninvalid ???\n", "utf8");
    });
    const before = await snapshot(fixture.root);

    const result = resultJson(await runCommand(["doctor"], fixture.runtime));

    expect(codes(result)).toContain("codex_feature_invalid");
    expect(codes(result)).not.toContain("codex_feature_enabled");
    expect(await snapshot(fixture.root)).toEqual(before);
  });
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly runtime: CommandRuntime & {
    readonly nodePath: string;
    readonly entrypointPath: string;
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentq-doctor-"));
  const workspace = path.join(root, "workspace-a");
  const profile = path.join(root, "profile");
  await mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    runtime: {
      cwd: workspace,
      env: {
        LOCALAPPDATA: path.join(root, "state"),
        HOME: profile,
        USERPROFILE: profile,
        CODEX_HOME: path.join(profile, ".codex")
      },
      now: () => "2026-07-11T00:00:00.000Z",
      nodePath: path.join(root, "bin", "node.exe"),
      entrypointPath: path.join(root, "bin", "agentq-main.js")
    }
  };
}

function resultJson(result: CommandResult): Record<string, any> {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function codes(result: Record<string, any>): string[] {
  return result.diagnostics.map((diagnostic: { code: string }) => diagnostic.code);
}

async function snapshot(root: string): Promise<readonly string[]> {
  const { createHash } = await import("node:crypto");
  const files: string[] = [];
  async function walk(relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  await walk("");
  return await Promise.all(
    files.sort().map(async (relative) => {
      const bytes = await readFile(path.join(root, relative));
      return `${relative.replace(/\\/g, "/")}\0${createHash("sha256").update(bytes).digest("hex")}`;
    })
  );
}
