import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceStore,
  resolveWorkspaceStore,
  type QuestionRecord,
  type WorkspaceStore
} from "../src/index.js";
import { foldQuestion, foldQuestionState } from "../src/state/fold.js";
import { writeOnceYaml } from "../src/store/writeOnce.js";

describe("question state fold", () => {
  it("classifies pending as actionable and nonterminal", () => {
    expect(foldQuestion(question("pending"))).toMatchObject({
      status: "pending",
      actionable: true,
      terminal: false
    });
  });

  it.each(["answered", "not_mine", "cancelled"] as const)(
    "classifies %s as terminal and non-actionable",
    (status) => {
      expect(foldQuestion(question(status))).toMatchObject({
        status,
        actionable: false,
        terminal: true
      });
    }
  );

  it("loads and validates one persisted question record", async () => {
    const store = await createStore();
    const record = question("pending");
    await writeOnceYaml(store.layout.questionPath(record.id), record);

    await expect(foldQuestionState(store, record.id)).resolves.toMatchObject({
      question: record,
      status: "pending",
      actionable: true,
      terminal: false
    });
  });
});

function question(status: QuestionRecord["status"]): QuestionRecord {
  return {
    id: "question_fold_fixture",
    senderActorId: "actor_000000000000000000000001",
    recipientActorId: "actor_000000000000000000000002",
    question: "Who owns this file?",
    scope: { paths: ["src/**"], resources: [], contracts: [] },
    status,
    ...(status === "answered" ? { answer: "The recipient owns it." } : {}),
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

async function createStore(): Promise<WorkspaceStore> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-fold-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "linux",
    env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  return store;
}
