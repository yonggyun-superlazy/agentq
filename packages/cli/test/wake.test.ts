import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/main.js";

describe("CLI wake", () => {
  it("lists pending actors and renders inbox inspection without resume commands", async () => {
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

    const question = await runCommand([
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

    expect(question.stdout).toContain("record_only");
    expect(question.stdout).not.toContain("command=");
    await expect(runCommand(["wake", "list"], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining(receiver)
    });
    const inspect = await runCommand(["wake", "--actor", receiver], runtime);

    expect(inspect).toMatchObject({
      code: 0,
      stderr: ""
    });
    expect(inspect.stdout).toContain("agentq wake inspect");
    expect(inspect.stdout).toContain("headless resume execution is removed");
    expect(inspect.stdout).toContain("claude-session");
    expect(inspect.stdout).toContain("AQ-wake");
    expect(inspect.stdout).toContain(`agentq inbox --actor ${receiver}`);
    expect(inspect.stdout).not.toContain("command: claude");
    await expect(runCommand(["wake", "--actor", receiver, "--execute"], runtime))
      .rejects.toThrow("wake --execute was removed");
  });

  it("keeps Copilot wake inspection free of non-interactive resume commands", async () => {
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

    const inspect = await runCommand(["wake", "--actor", receiver], runtime);
    expect(inspect.stdout).toContain("copilot-session");
    expect(inspect.stdout).toContain(`agentq inbox --actor ${receiver}`);
    expect(inspect.stdout).not.toContain("command: copilot");
    expect(inspect.stdout).not.toContain("--resume=copilot-session");
  });
});
