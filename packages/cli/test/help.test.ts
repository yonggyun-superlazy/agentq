import { describe, expect, it } from "vitest";
import { COMMANDS, renderHelp, runCommand } from "../src/main.js";

describe("CLI help", () => {
  it("shows the first public command surface without store/config escape hatches", () => {
    const help = renderHelp();

    expect(help).toContain("The handshake between coding agents.");
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

  it("documents wake as explicit delivery without public adapter flags", async () => {
    const result = await runCommand(["wake", "--help"]);

    expect(result.stdout).toContain("explicit delivery attempt");
    expect(result.stdout).toContain("not an automatic side effect");
    expect(result.stdout).toContain("Adapter limits are handled by AgentQ");
    expect(result.stdout).not.toContain("experimental-copilot");
  });

  it("fails unknown commands before writing runtime state", async () => {
    await expect(runCommand(["unknown"])).resolves.toEqual({
      code: 2,
      stdout: "",
      stderr: "agentq: unknown command: unknown\n"
    });
  });
});
