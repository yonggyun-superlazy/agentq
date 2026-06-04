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
    expect(agentsBlock).toContain("Quality reviews inspect actual messages");
    expect(agentsBlock).toContain("Keep queue/status/next-action narration behind the requested result");
    expect(agentsBlock).toContain("Hide internal ids, commands");
    expect(agentsBlock).not.toContain("done-check");
    expect(claudeBlock).not.toContain("agentq next");
    expect(agentsBlock).toContain("routes, not locks");
    expect(claudeBlock).toContain("routes, not locks");
    expect(scopedBlock).toContain("required questions only for exact overlap");
    expect(scopedBlock).toContain("one-decision required questions");
    expect(agentsBlock).not.toContain("agentq work start/status/evidence/close");
    expect(claudeBlock).not.toContain("agentq work start/status/evidence/close");
    expect(scopedBlock).toContain("Shared work coordinates overlap");
    expect(scopedBlock).toContain("never the user's requested artifact");
    expect(scopedBlock).toContain("Put the latest user request first");
    expect(scopedBlock).toContain("never replace an explanation, diagnosis, critique");
    expect(scopedBlock).toContain("queue/status/next-action narration");
    expect(scopedBlock).toContain("quality/process complaints");
    expect(scopedBlock).toContain("inspect actual messages");
    expect(scopedBlock).toContain("same-prompt before/after outputs first");
    expect(scopedBlock).toContain("Do not create work frames, reports, instruction edits");
    expect(scopedBlock).toContain("answer the correction unless an actual edit or handoff is needed");
    expect(scopedBlock).toContain("helper when needed");
    expect(scopedBlock).toContain("surface only the user-impacting result");
    expect(scopedBlock).toContain("Short read-only answers");
    expect(scopedBlock).toContain("not stop conditions or quality proof");
    expect(scopedBlock).toContain("aggregate diagnostics are triage");
    expect(scopedBlock).toContain("Required replies");
    expect(scopedBlock).toContain("Active frame is focus/order, not scope shrink");
    expect(scopedBlock).toContain("parent denominator");
    expect(scopedBlock).toContain("same-row delete+replacement pass criteria");
    expect(scopedBlock).toContain("Keep internal ids, command names");
    expect(scopedBlock).not.toContain("AgentQ handles required-response queues");
    expect(scopedBlock).not.toContain("Usage diagnostics must classify metrics by agent type");
    expect(scopedBlock).not.toContain("agentq next --actor");
    expect(scopedBlock).not.toContain("agentq work start --actor");
    expect(scopedBlock).not.toContain("agentq done-check");
    expect(scopedBlock.split("\n").length).toBeLessThanOrEqual(16);
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
