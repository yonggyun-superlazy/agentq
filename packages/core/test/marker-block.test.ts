import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTQ_MARKER_BEGIN,
  AGENTQ_MARKER_END,
  applyMarkerInstall,
  applyMarkerUninstall,
  DEFAULT_MARKER_TARGETS,
  planMarkerInstall,
  renderMarkerBlock,
  removeMarkerBlock,
  upsertMarkerBlock
} from "../src/index.js";

describe("AgentQ marker installer", () => {
  it("inserts a marker without changing existing bytes outside the marker", () => {
    const original = "before\n";
    const block = renderMarkerBlock(DEFAULT_MARKER_TARGETS[0]);
    const edit = upsertMarkerBlock(original, block);

    expect(edit.action).toBe("create");
    expect(edit.content.startsWith(original)).toBe(true);
    expect(edit.content).toContain(AGENTQ_MARKER_BEGIN);
    expect(edit.content).toContain(AGENTQ_MARKER_END);
  });

  it("updates an existing marker and preserves prefix and suffix", () => {
    const original = `prefix\n${AGENTQ_MARKER_BEGIN}\nold\n${AGENTQ_MARKER_END}\nsuffix\n`;
    const block = `${AGENTQ_MARKER_BEGIN}\nnew\n${AGENTQ_MARKER_END}\n`;
    const edit = upsertMarkerBlock(original, block);

    expect(edit.action).toBe("update");
    expect(edit.content).toBe(`prefix\n${block}suffix\n`);
  });

  it("rejects duplicate marker blocks instead of guessing which one to edit", () => {
    const duplicate = [
      AGENTQ_MARKER_BEGIN,
      AGENTQ_MARKER_END,
      AGENTQ_MARKER_BEGIN,
      AGENTQ_MARKER_END
    ].join("\n");

    expect(() => removeMarkerBlock(duplicate)).toThrow(/multiple marker blocks/);
  });

  it("dry-runs without writing files", async () => {
    const workspace = await createWorkspace();

    const plan = await planMarkerInstall(workspace);

    expect(plan.entries.map((entry) => entry.action)).toEqual(["create", "create", "create"]);
    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("installs and uninstalls only AgentQ-owned marker content", async () => {
    const workspace = await createWorkspace();
    await writeText(path.join(workspace, "AGENTS.md"), "project instructions\n");
    await writeText(path.join(workspace, "CLAUDE.md"), "claude instructions\n");

    await applyMarkerInstall(workspace);

    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).resolves.toContain(
      AGENTQ_MARKER_BEGIN
    );
    await expect(
      readFile(path.join(workspace, ".github", "instructions", "agentq.instructions.md"), "utf8")
    ).resolves.toContain('applyTo: "**"');

    await applyMarkerUninstall(workspace);

    await expect(readFile(path.join(workspace, "AGENTS.md"), "utf8")).resolves.toBe(
      "project instructions\n\n"
    );
    await expect(readFile(path.join(workspace, "CLAUDE.md"), "utf8")).resolves.toBe(
      "claude instructions\n\n"
    );
    await expect(
      readFile(path.join(workspace, ".github", "instructions", "agentq.instructions.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the generated instruction block under the install trust budget", () => {
    for (const target of DEFAULT_MARKER_TARGETS) {
      const budget = target.relativePath === ".github/instructions/agentq.instructions.md" ? 2300 : 520;
      expect(Buffer.byteLength(renderMarkerBlock(target), "utf8")).toBeLessThan(budget);
    }
  });

  it("keeps root markers as pointers to the scoped shared-work procedure", () => {
    const [agentsBlock, claudeBlock, scopedBlock] = DEFAULT_MARKER_TARGETS.map((target) =>
      renderMarkerBlock(target)
    );

    expect(agentsBlock).toContain(".github/instructions/agentq.instructions.md");
    expect(claudeBlock).toContain(".github/instructions/agentq.instructions.md");
    expect(agentsBlock).toContain("Short read-only answers");
    expect(claudeBlock).toContain("tracked work");
    expect(agentsBlock).toContain("Hide internal system/command names");
    expect(agentsBlock).not.toContain("done-check");
    expect(claudeBlock).not.toContain("agentq next");
    expect(agentsBlock).toContain("routes, not locks");
    expect(claudeBlock).toContain("routes, not locks");
    expect(scopedBlock).toContain("questions for overlap");
    expect(agentsBlock).not.toContain("agentq work start/status/evidence/close");
    expect(claudeBlock).not.toContain("agentq work start/status/evidence/close");
    expect(scopedBlock).toContain("Shared work handles required-response queues");
    expect(scopedBlock).toContain("before the first edit");
    expect(scopedBlock).toContain("shared-work helper print exact next operations");
    expect(scopedBlock).toContain("docs/rules/shared-work-commands.md");
    expect(scopedBlock).toContain("External build/test/generated failures should be recorded with evidence");
    expect(scopedBlock).toContain("Short read-only answers");
    expect(scopedBlock).toContain("not stop conditions");
    expect(scopedBlock).toContain("smallest non-overlapping local step");
    expect(scopedBlock).toContain("required reply");
    expect(scopedBlock).toContain("Usage diagnostics must classify metrics by agent type");
    expect(scopedBlock).toContain("Codex: broad session presence is bookkeeping");
    expect(scopedBlock).toContain("Claude Code: edit nudges require active work/evidence adoption");
    expect(scopedBlock).toContain("Copilot CLI: report local samples separately");
    expect(scopedBlock).toContain("Answer the requested artifact first");
    expect(scopedBlock).toContain("no evidence-free judgment");
    expect(scopedBlock).toContain("permission-question ending");
    expect(scopedBlock).toContain("active frame is focus/order, not scope shrink");
    expect(scopedBlock).toContain("parent denominator");
    expect(scopedBlock).toContain("same-row delete+replacement pass criteria");
    expect(scopedBlock).toContain("Keep internal system names");
    expect(scopedBlock).not.toContain("AgentQ handles required-response queues");
    expect(scopedBlock).not.toContain("agentq next --actor");
    expect(scopedBlock).not.toContain("agentq work start --actor");
    expect(scopedBlock).not.toContain("agentq done-check");
    expect(Buffer.byteLength(agentsBlock, "utf8")).toBeLessThan(
      Buffer.byteLength(scopedBlock, "utf8")
    );
  });
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agentq-install-"));
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function writeText(filePath: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
