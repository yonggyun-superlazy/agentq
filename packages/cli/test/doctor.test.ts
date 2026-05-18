import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/main.js";

describe("CLI doctor", () => {
  it("explains installed markers and complete hook gates", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-doctor-"));

    await runCommand(["install", "--yes"], runtime(workspace));
    const result = await runCommand(["doctor"], runtime(workspace));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("AgentQ doctor: ok");
    expect(result.stdout).toContain("Codex hook gate");
    expect(result.stdout).toContain(".codex/hooks.json contains all AgentQ hook entries");
    expect(result.stdout).toContain("no repo .agentq directory found");
  });
});

function runtime(cwd: string) {
  return {
    cwd,
    env: { LOCALAPPDATA: path.join(cwd, "local-app-data") },
    now: () => "2026-05-18T00:00:00.000Z"
  };
}
