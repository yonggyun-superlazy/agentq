import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/main.js";

describe("CLI wake", () => {
  it("lists pending actors and renders a Claude resume dry-run", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-wake-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "AgentQ",
      "--responsibility",
      "wake sender"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "claude-code",
      "--session",
      "claude-session",
      "--paths",
      "AgentQ",
      "--responsibility",
      "wake receiver"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await runCommand([
      "question",
      "--id",
      "AQ-wake",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "AgentQ",
      "--question",
      "Please answer via AgentQ.",
      "--pass",
      "receiver responds"
    ], runtime);

    await expect(runCommand(["wake", "list"], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining(receiver)
    });
    const dryRun = await runCommand(["wake", "--actor", receiver], runtime);

    expect(dryRun).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(dryRun.stdout).toContain("agentq wake dry-run");
    expect(dryRun.stdout).toContain("command: claude");
    expect(dryRun.stdout).toContain("claude-session");
    expect(dryRun.stdout).toContain("AQ-wake");
    expect(dryRun.stdout).toContain(`agentq inbox --actor ${receiver}`);
  });

  it("keeps Copilot policy inside the adapter dry-run", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-wake-copilot-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "sender",
      "--paths",
      "AgentQ",
      "--responsibility",
      "wake sender"
    ], runtime)).stdout.trim().replace(/ registered$/, "");
    const receiver = (await runCommand([
      "enter",
      "--as",
      "copilot-cli",
      "--session",
      "copilot-session",
      "--paths",
      "AgentQ",
      "--responsibility",
      "wake receiver"
    ], runtime)).stdout.trim().replace(/ registered$/, "");

    await runCommand([
      "question",
      "--id",
      "AQ-copilot-wake",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "AgentQ",
      "--question",
      "Please answer via AgentQ.",
      "--pass",
      "receiver responds"
    ], runtime);

    const dryRun = await runCommand(["wake", "--actor", receiver], runtime);
    expect(dryRun.stdout).toContain("command: copilot");
    expect(dryRun.stdout).toContain("--resume=copilot-session");
    expect(dryRun.stdout).toContain("policy: limited");
  });
});
