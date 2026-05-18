import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/main.js";

describe("CLI work stack", () => {
  it("lists actors and gates done-check on active work until evidence and close", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-work-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };

    const entered = await runCommand([
      "enter",
      "--as",
      "codex",
      "--session",
      "work-test",
      "--paths",
      "AgentQ",
      "--responsibility",
      "work stack"
    ], runtime);
    const actorId = entered.stdout.trim().replace(/ registered$/, "");

    await expect(runCommand(["actors"], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining(actorId)
    });

    await expect(runCommand([
      "work",
      "start",
      "--actor",
      actorId,
      "--id",
      "AW-cli",
      "--title",
      "Implement work stack",
      "--path",
      "AgentQ/packages/core/src/work/workStack.ts"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("started: AW-cli")
    });

    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("work-check failed")
    });
    await expect(runCommand([
      "work",
      "touch",
      "--actor",
      actorId,
      "--path",
      "AgentQ/packages/cli/src/main.ts"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("AgentQ/packages/cli/src/main.ts")
    });
    await expect(runCommand([
      "work",
      "evidence",
      "--actor",
      actorId,
      "--evidence",
      "CLI work test recorded evidence"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("evidence: 1")
    });
    await expect(runCommand([
      "work",
      "close",
      "--actor",
      actorId,
      "--summary",
      "CLI work stack closed"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("closed: AW-cli")
    });
    await expect(runCommand(["done-check", "--actor", actorId], runtime)).resolves.toEqual({
      code: 0,
      stdout: "ok: no required replies or active work remain open\n",
      stderr: ""
    });
  });

  it("lets the sender supersede an outbound request without impersonating the receiver", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-cli-supersede-"));
    const runtime = {
      cwd: workspace,
      env: { LOCALAPPDATA: path.join(workspace, "local-app-data") },
      now: () => "2026-05-18T00:00:00.000Z"
    };
    const sender = (await runCommand(["enter", "--as", "codex", "--session", "sender"], runtime)).stdout
      .trim()
      .replace(/ registered$/, "");
    const receiver = (await runCommand(["enter", "--as", "claude-code", "--session", "receiver"], runtime)).stdout
      .trim()
      .replace(/ registered$/, "");

    await runCommand([
      "block",
      "--id",
      "AQ-supersede",
      "--actor",
      sender,
      "--to",
      receiver,
      "--path",
      "README.md",
      "--summary",
      "Propagation request"
    ], runtime);
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("outbound_pending")
    });

    await expect(runCommand([
      "supersede",
      "AQ-supersede",
      "--actor",
      sender,
      "--to",
      receiver,
      "--evidence",
      "receiver is stale; propagation remains documented"
    ], runtime)).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining("superseded")
    });
    await expect(runCommand(["done-check", "--actor", sender], runtime)).resolves.toMatchObject({
      code: 0
    });
    await expect(runCommand(["inbox", "--actor", receiver], runtime)).resolves.toEqual({
      code: 0,
      stdout: "inbox empty\n",
      stderr: ""
    });
  });
});
