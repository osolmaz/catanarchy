import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { STANDARD_BOARD_GENERATOR_ID } from "@catanarchy/engine";
import {
  createFirstLegalAgent,
  runGameSteps,
  type AgentResume,
  type MatchRunResult,
  type NegotiationPolicy,
} from "@catanarchy/harness";
import type { GameConfig } from "@catanarchy/protocol";
import {
  readRunPackage,
  RunRecorder,
  type CreateRunRecorderOptions,
  type InitialStateOrigin,
  type RunResume,
} from "@catanarchy/run-log";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "resumed-match",
  seed: 47,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
  ],
};

const initialStateOrigin: InitialStateOrigin = {
  type: "generated",
  generatorId: STANDARD_BOARD_GENERATOR_ID,
  seed: config.seed,
};

const negotiationPolicy: NegotiationPolicy = {
  maxRounds: 1,
  maxMessageLength: 120,
  maxOpenOffers: 4,
};

const temporaryRunDirectory = async (name: string): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "catanarchy-resume-"));
  roots.push(root);
  return resolve(root, name);
};

const startRun = (
  directory: string,
  runId: string,
  seats: CreateRunRecorderOptions["seats"] = config.players.map(({ id }) => ({
    seatId: id,
    agentType: "scripted" as const,
    model: null,
  })),
): Promise<RunRecorder> =>
  RunRecorder.create({ directory, runId, config, initialStateOrigin, seats });

interface PlayOptions {
  readonly maxDecisions: number;
  readonly resume?: AgentResume;
  readonly policy?: NegotiationPolicy;
}

const play = (recorder: RunRecorder, options: PlayOptions): Promise<MatchRunResult> =>
  Effect.runPromise(
    runGameSteps({
      config,
      maxDecisions: options.maxDecisions,
      createAgent: async () => createFirstLegalAgent(),
      onActivity: async (activity) => recorder.recordActivity(activity),
      ...(options.policy === undefined ? {} : { negotiationPolicy: options.policy }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    }),
  );

const agentResume = (resume: RunResume): AgentResume => ({
  state: resume.state,
  events: resume.events,
  eventPayloads: resume.eventPayloads,
  negotiations: resume.negotiations,
  decisionCount: resume.decisionCount,
});

const recordKinds = (directory: string): Promise<ReadonlyArray<string>> =>
  readRunPackage(directory).then((pkg) => pkg.records.map(({ kind }) => kind));

const gameEvents = (directory: string): Promise<ReadonlyArray<unknown>> =>
  readRunPackage(directory).then((pkg) =>
    pkg.records.flatMap((record) => (record.kind === "game.event" ? [record.payload] : [])),
  );

const timelineText = (directory: string): Promise<string> =>
  readFile(resolve(directory, "timeline.jsonl"), "utf8");

const rewriteTimeline = async (
  directory: string,
  change: (records: Array<Record<string, unknown>>) => void,
): Promise<void> => {
  const path = resolve(directory, "timeline.jsonl");
  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  change(records);
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
};

const appendRecord = async (directory: string, payload: unknown): Promise<void> => {
  const pkg = await readRunPackage(directory);
  const last = pkg.records.at(-1);
  if (last === undefined) throw new Error("Expected a stored record.");
  await appendFile(
    resolve(directory, "timeline.jsonl"),
    `${JSON.stringify({
      schema: "catanarchy.run-record.v1",
      runId: last.runId,
      index: last.index + 1,
      offsetMs: last.offsetMs + 1,
      recordedAt: new Date(1_789_012_800_000 + last.offsetMs + 1).toISOString(),
      kind: "negotiation.decision",
      visibility: "referee",
      payload,
    })}\n`,
  );
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("resume", () => {
  it("continues a stopped run into the same state as an uninterrupted run", async () => {
    const uninterruptedDirectory = await temporaryRunDirectory("uninterrupted");
    const uninterrupted = await startRun(uninterruptedDirectory, "run-uninterrupted");
    const whole = await play(uninterrupted, { maxDecisions: 6 });
    await uninterrupted.complete(whole);
    expect(whole.state.sequence).toBeGreaterThan(0);

    const stoppedDirectory = await temporaryRunDirectory("stopped");
    const stopped = await startRun(stoppedDirectory, "run-stopped");
    await play(stopped, { maxDecisions: 3 });
    await stopped.close();

    const beforeOpen = await readRunPackage(stoppedDirectory);
    expect(beforeOpen.manifest.status).toBe("partial");
    expect(beforeOpen.resume?.decisionCount).toBe(3);

    const opened = await RunRecorder.open({
      directory: stoppedDirectory,
      mode: "cold",
      reason: "unit test resume",
    });
    expect(opened.resume.nextIndex).toBe(beforeOpen.records.length);
    const resumed = await play(opened.recorder, {
      maxDecisions: 6,
      resume: agentResume(opened.resume),
    });
    await opened.recorder.complete(resumed);

    expect(resumed.state).toEqual(whole.state);
    expect(resumed.events).toEqual(whole.events);
    expect(await gameEvents(stoppedDirectory)).toEqual(await gameEvents(uninterruptedDirectory));

    const finished = await readRunPackage(stoppedDirectory);
    expect(finished.manifest.status).toBe("completed");
    expect(finished.verification).toEqual({
      generatorMatch: "matches-current",
      commandVerification: "exact",
    });
    expect(finished.records.filter(({ kind }) => kind === "game.decision")).toHaveLength(6);
    expect(finished.records.map(({ index }) => index)).toEqual(
      finished.records.map((_record, index) => index),
    );
    const offsets = finished.records.map(({ offsetMs }) => offsetMs);
    expect(offsets.toSorted((left, right) => left - right)).toEqual(offsets);
  });

  it("records the resume seam so a reader can find it", async () => {
    const directory = await temporaryRunDirectory("seam");
    const recorder = await startRun(directory, "run-seam");
    await play(recorder, { maxDecisions: 2 });
    const before = await readRunPackage(directory);
    await recorder.close();

    const opened = await RunRecorder.open({
      directory,
      mode: "warm",
      reason: "operator stopped the run",
      clock: { monotonicMs: () => 0, utcNow: () => new Date(1_789_012_800_000) },
    });
    await opened.recorder.close();

    const after = await readRunPackage(directory);
    const seamed = after.records.find(({ kind }) => kind === "run.resumed");
    expect(seamed).toMatchObject({
      index: before.records.length,
      offsetMs: before.records.at(-1)?.offsetMs,
      kind: "run.resumed",
      payload: {
        mode: "warm",
        resumedAtIndex: before.records.length,
        replayedSequence: opened.resume.replayedSequence,
        verification: "exact",
        reason: "operator stopped the run",
      },
    });
    expect(after.resume?.nextIndex).toBe(after.records.length);
  });

  it("refuses a terminal run before it writes", async () => {
    const directory = await temporaryRunDirectory("terminal");
    const recorder = await startRun(directory, "run-terminal");
    const result = await play(recorder, { maxDecisions: 2 });
    await recorder.complete(result);
    const before = await timelineText(directory);

    await expect(RunRecorder.open({ directory, mode: "cold", reason: "terminal" })).rejects.toThrow(
      /cannot resume/u,
    );
    expect(await timelineText(directory)).toBe(before);
  });

  it("refuses a stored prefix that does not replay", async () => {
    const directory = await temporaryRunDirectory("broken-prefix");
    const recorder = await startRun(directory, "run-broken-prefix");
    await play(recorder, { maxDecisions: 3 });
    await recorder.close();

    await rewriteTimeline(directory, (records) => {
      const target = records.find((record) => {
        const payload = record["payload"] as Record<string, unknown> | undefined;
        const event = payload?.["event"] as Record<string, unknown> | undefined;
        return event?.["type"] === "road.placed";
      });
      if (target === undefined) throw new Error("Expected a stored road event.");
      const payload = target["payload"] as Record<string, unknown>;
      const event = payload["event"] as Record<string, unknown>;
      event["edgeId"] = "e:v:not-a-real-edge";
    });
    const before = await timelineText(directory);

    await expect(RunRecorder.open({ directory, mode: "cold", reason: "broken" })).rejects.toThrow(
      /replay|invalid|native/u,
    );
    expect(await timelineText(directory)).toBe(before);
  });

  it("lets exactly one opener hold the run lock", async () => {
    const directory = await temporaryRunDirectory("lock");
    const recorder = await startRun(directory, "run-lock");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();

    const first = await RunRecorder.open({ directory, mode: "cold", reason: "first" });
    await expect(RunRecorder.open({ directory, mode: "cold", reason: "second" })).rejects.toThrow(
      /run lock/u,
    );

    await first.recorder.close();
    const second = await RunRecorder.open({ directory, mode: "cold", reason: "second" });
    await second.recorder.close();
    expect(await recordKinds(directory)).toContain("run.resumed");
  });

  it("takes over the lock of a dead process", async () => {
    const directory = await temporaryRunDirectory("stale-lock");
    const recorder = await startRun(directory, "run-stale-lock");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();

    await writeFile(resolve(directory, "run.lock"), "999999999\n", "utf8");
    const opened = await RunRecorder.open({ directory, mode: "cold", reason: "stale lock" });
    expect(opened.resume.nextIndex).toBe((await readRunPackage(directory)).records.length - 1);
    await opened.recorder.close();
  });

  it("refuses a warm resume when a seat session file is missing", async () => {
    const directory = await temporaryRunDirectory("warm-missing");
    const recorder = await startRun(
      directory,
      "run-warm-missing",
      config.players.map(({ id }) => ({
        seatId: id,
        agentType: "pi" as const,
        model: { provider: "test", modelId: "model" },
      })),
    );
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();
    const before = await timelineText(directory);

    await expect(RunRecorder.open({ directory, mode: "warm", reason: "warm" })).rejects.toThrow(
      /warm resume needs every seat session/u,
    );
    expect(await timelineText(directory)).toBe(before);

    const cold = await RunRecorder.open({ directory, mode: "cold", reason: "cold" });
    await cold.recorder.close();
  });

  it("resolves the recorded seat sessions for a warm resume and none for a cold one", async () => {
    const directory = await temporaryRunDirectory("warm");
    const recorder = await startRun(
      directory,
      "run-warm",
      config.players.map(({ id }) => ({
        seatId: id,
        agentType: "pi" as const,
        model: { provider: "test", modelId: "model" },
      })),
    );
    await play(recorder, { maxDecisions: 2 });
    const expected: Array<[string, string]> = [];
    for (const { id } of config.players) {
      const sessionFile = resolve(recorder.sessionsDirectory, `${id}.jsonl`);
      await writeFile(sessionFile, '{"type":"message"}\n');
      await recorder.registerPiSession(id, { sessionId: `session-${id}`, sessionFile });
      expected.push([id, sessionFile]);
    }
    await recorder.close();

    const warm = await RunRecorder.open({ directory, mode: "warm", reason: "warm" });
    expect([...warm.sessions]).toEqual(expected);
    expect((await readRunPackage(directory)).records.at(-1)).toMatchObject({
      kind: "run.resumed",
      payload: { mode: "warm" },
    });
    await warm.recorder.close();

    const cold = await RunRecorder.open({ directory, mode: "cold", reason: "cold" });
    expect(cold.sessions.size).toBe(0);
    expect((await readRunPackage(directory)).records.at(-1)).toMatchObject({
      kind: "run.resumed",
      payload: { mode: "cold" },
    });
    await cold.recorder.close();
  });

  it("does not reopen a negotiation window that already closed", async () => {
    const directory = await temporaryRunDirectory("negotiation");
    const recorder = await startRun(directory, "run-negotiation");
    await play(recorder, { maxDecisions: 16, policy: negotiationPolicy });
    await recorder.close();

    const beforeOpen = await readRunPackage(directory);
    const openedWindows = beforeOpen.resume?.negotiations.filter(
      ({ event }) => event.type === "negotiation.window-opened",
    );
    expect(openedWindows?.length).toBeGreaterThan(0);

    const opened = await RunRecorder.open({
      directory,
      mode: "cold",
      reason: "negotiation resume",
    });
    const resumed = await play(opened.recorder, {
      maxDecisions: 24,
      policy: negotiationPolicy,
      resume: agentResume(opened.resume),
    });
    await opened.recorder.complete(resumed);
    expect(resumed.state.sequence).toBeGreaterThan(beforeOpen.resume?.replayedSequence ?? 0);

    const finished = await readRunPackage(directory);
    const turns = finished.records.flatMap((record) => {
      if (record.kind !== "negotiation.event") return [];
      const { event } = record.payload;
      return event.type === "negotiation.window-opened" ? [event.turn] : [];
    });
    expect(turns.length).toBeGreaterThan(openedWindows?.length ?? 0);
    expect(new Set(turns).size).toBe(turns.length);
  });

  it("carries the observed spend of the stored prefix into the resume", async () => {
    const directory = await temporaryRunDirectory("spend");
    const recorder = await startRun(directory, "run-spend");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();

    await appendRecord(directory, {
      matchId: config.matchId,
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.25 },
    });
    await appendRecord(directory, {
      matchId: config.matchId,
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.75 },
    });

    const pkg = await readRunPackage(directory);
    expect(pkg.resume?.observedSpendUsd).toBeCloseTo(1, 10);
    expect(pkg.resume?.decisionCount).toBe(2);
  });

  it("trims a truncated final line and rejects a corrupt one", async () => {
    const directory = await temporaryRunDirectory("truncated");
    const recorder = await startRun(directory, "run-truncated");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();
    const before = await readRunPackage(directory);

    await appendFile(
      resolve(directory, "timeline.jsonl"),
      '{"schema":"catanarchy.run-record.v1","runId":"run-truncated"',
    );
    const opened = await RunRecorder.open({ directory, mode: "cold", reason: "truncated tail" });
    await opened.recorder.close();

    const after = await readRunPackage(directory);
    expect(after.records.map(({ kind }) => kind).slice(0, before.records.length)).toEqual(
      before.records.map(({ kind }) => kind),
    );
    expect(after.records.at(-1)?.kind).toBe("run.resumed");

    await appendFile(resolve(directory, "timeline.jsonl"), '{"garbage":true}\n');
    const withCorruptTail = await timelineText(directory);
    await expect(RunRecorder.open({ directory, mode: "cold", reason: "corrupt" })).rejects.toThrow(
      /record is invalid/u,
    );
    expect(await timelineText(directory)).toBe(withCorruptTail);
  });
});
