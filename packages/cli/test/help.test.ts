import { describe, expect, it } from "vitest";
import { COMMANDS, renderHelp, runCommand } from "../src/main.js";

describe("CLI help", () => {
  it("shows the first public command surface without store/config escape hatches", () => {
    const help = renderHelp();

    expect(help).toContain("The handshake between coding agents.");
    expect(help).toContain("next");
    expect(help).toContain("done-check");
    expect(help).toContain("question");
    expect(help).toContain("accept-blocked");
    expect(help).toContain("coordination, not orchestration");
    expect(help).not.toContain("init");
    expect(help).not.toContain("heartbeat");
    expect(help).not.toContain("--store");
    expect(help).not.toContain("agentq.config.yaml");
  });

  it("exposes every first release command as a help surface", async () => {
    for (const command of COMMANDS) {
      const result = await runCommand([command.name, "--help"]);

      expect(result).toEqual({
        code: 0,
        stdout: expect.stringContaining(`agentq ${command.name}`),
        stderr: ""
      });
      expect(result.stdout).not.toContain("Runtime behavior is implemented by the matching queue row.");
    }
  });

  it("documents wake as inspection-only", async () => {
    const result = await runCommand(["wake", "--help"]);

    expect(result.stdout).toContain("Inspect pending delivery targets");
    expect(result.stdout).toContain("inspection-only");
    expect(result.stdout).toContain("never starts headless resume processes");
    expect(result.stdout).not.toContain("--execute");
    expect(result.stdout).not.toContain("experimental-copilot");
  });

  it("keeps state out of the public command surface and suggests the durable workflow", async () => {
    const result = await runCommand(["state", "--paths", "ProjectDD/DD.Shared"]);

    expect(result).toMatchObject({
      code: 2,
      stdout: ""
    });
    expect(renderHelp()).not.toContain("\n  state");
    expect(result.stderr).toContain("agentq: unknown command: state");
    expect(result.stderr).toContain("State is not an AgentQ command");
    expect(result.stderr).toContain("agentq owners --path ProjectDD/DD.Shared");
  });

  it("suggests durable commands for common guessed command names", async () => {
    await expect(runCommand(["list", "--help"])).resolves.toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("agentq actors")
    });
    await expect(runCommand(["who", "--path", "ProjectDD/DD.Shared"])).resolves.toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("agentq owners --path ProjectDD/DD.Shared")
    });
    await expect(runCommand(["ask", "--help"])).resolves.toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("agentq question --help")
    });
    await expect(runCommand(["reply", "--help"])).resolves.toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("agentq respond --help")
    });
    await expect(runCommand(["queue", "--help"])).resolves.toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("agentq inbox --actor <id>")
    });
  });

  it("fails unknown commands before writing runtime state", async () => {
    await expect(runCommand(["unknown"])).resolves.toEqual({
      code: 2,
      stdout: "",
      stderr: "agentq: unknown command: unknown\n"
    });
  });
});
