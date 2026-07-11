import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  cancelQuestion,
  createQuestion,
  declineQuestionAsNotMine,
  ensureWorkspaceStore,
  listInbox,
  registerAdapterSession,
  resolveWorkspaceStore,
  setClaims,
  type ClaimSnapshot,
  type QuestionRecord,
  type WorkspaceStore
} from "../src/index.js";
import { QuestionRecordSchema } from "../src/domain/schema.js";
import { readQuestionRecord } from "../src/state/fold.js";

describe("five-operation question lifecycle", () => {
  it("exports the reduced persisted question schema", () => {
    expect(QuestionRecordSchema).toBeDefined();
  });

  it("lists pending received questions without mutating persisted state", async () => {
    const fixture = await createFixture();
    const question = await ask(fixture);
    const sourceBefore = await readFile(fixture.store.layout.questionPath(question.id), "utf8");

    const inbox = await listInbox(fixture.store, fixture.recipientActorId);

    expect(inbox).toEqual([question]);
    await expect(readFile(fixture.store.layout.questionPath(question.id), "utf8")).resolves.toBe(
      sourceBefore
    );
  });

  it("allows only the recipient to answer a pending question", async () => {
    const fixture = await createFixture();
    const question = await ask(fixture);

    await expect(
      answerQuestion(fixture.store, question.id, fixture.senderActorId, "wrong actor")
    ).rejects.toThrow(/recipient/i);
    const answered = await answerQuestion(
      fixture.store,
      question.id,
      fixture.recipientActorId,
      "The core owner is changing it."
    );

    expect(answered).toMatchObject({
      status: "answered",
      answer: "The core owner is changing it."
    });
    await expect(listInbox(fixture.store, fixture.recipientActorId)).resolves.toEqual([]);
    await expect(
      declineQuestionAsNotMine(fixture.store, question.id, fixture.recipientActorId)
    ).rejects.toThrow(/terminal|pending/i);
  });

  it("allows only the recipient to decline as not_mine", async () => {
    const fixture = await createFixture();
    const question = await ask(fixture);

    await expect(
      declineQuestionAsNotMine(fixture.store, question.id, fixture.senderActorId)
    ).rejects.toThrow(/recipient/i);
    await expect(
      declineQuestionAsNotMine(fixture.store, question.id, fixture.recipientActorId)
    ).resolves.toMatchObject({ status: "not_mine" });
  });

  it("allows only the sender to cancel a pending question", async () => {
    const fixture = await createFixture();
    const question = await ask(fixture);

    await expect(
      cancelQuestion(fixture.store, question.id, fixture.recipientActorId)
    ).rejects.toThrow(/sender/i);
    await expect(
      cancelQuestion(fixture.store, question.id, fixture.senderActorId)
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("allows exactly one concurrent terminal transition", async () => {
    const fixture = await createFixture();
    const question = await ask(fixture);

    const results = await Promise.allSettled([
      answerQuestion(
        fixture.store,
        question.id,
        fixture.recipientActorId,
        "The recipient owns this file."
      ),
      cancelQuestion(fixture.store, question.id, fixture.senderActorId)
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<QuestionRecord> => result.status === "fulfilled"
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(Error);
    expect((rejected[0]?.reason as Error).message).toMatch(/terminal|pending/i);

    const authoritative = await readQuestionRecord(fixture.store, question.id);
    expect(authoritative).toEqual(fulfilled[0]?.value);
    await expect(
      readFile(fixture.store.layout.questionPath(question.id), "utf8")
    ).resolves.toContain("status: pending");
    await expect(
      readFile(fixture.store.layout.questionTerminalPath(question.id), "utf8")
    ).resolves.toContain(`status: ${authoritative.status}`);
  });

  it.each(["resolved", "invalid", "blocked", "superseded", "note", "block", "follow_up", "done_check"])(
    "rejects removed persisted state %s",
    (status) => {
      expect(() =>
        QuestionRecordSchema.parse({
          id: "question_invalid_state",
          senderActorId: "actor_000000000000000000000001",
          recipientActorId: "actor_000000000000000000000002",
          question: "Who owns this?",
          scope: { paths: ["src/**"], resources: [], contracts: [] },
          status,
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        })
      ).toThrow();
    }
  );
});

interface Fixture {
  readonly store: WorkspaceStore;
  readonly senderActorId: string;
  readonly recipientActorId: string;
}

async function createFixture(): Promise<Fixture> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentq-question-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await resolveWorkspaceStore(workspace, {
    platform: "linux",
    env: { HOME: tempRoot, XDG_STATE_HOME: path.join(tempRoot, "state") }
  });
  await ensureWorkspaceStore(store);
  const senderActorId = await register(store, "sender");
  const recipientActorId = await register(store, "recipient", "claude");
  await setClaims(store, recipientActorId, scope(["src/**"], [], []));
  return { store, senderActorId, recipientActorId };
}

async function ask(fixture: Fixture): Promise<QuestionRecord> {
  return await createQuestion(fixture.store, {
    senderActorId: fixture.senderActorId,
    recipientActorId: fixture.recipientActorId,
    question: "Who owns src/file.ts?",
    scope: scope(["src/file.ts"], [], [])
  });
}

async function register(
  store: WorkspaceStore,
  nativeSessionId: string,
  adapterId = "codex"
): Promise<string> {
  const result = await registerAdapterSession(store, {
    adapterId,
    nativeSessionId,
    cwd: store.workspaceRoot,
    now: new Date().toISOString()
  });
  if (result.status !== "registered") {
    throw new Error(`registration unavailable: ${result.reason}`);
  }
  return result.actorId;
}

function scope(
  paths: readonly string[],
  resources: readonly string[],
  contracts: readonly string[]
): ClaimSnapshot {
  return { paths, resources, contracts };
}
