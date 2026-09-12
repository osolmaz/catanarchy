import { appendFile, link, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { STANDARD_BOARD_GENERATOR_ID } from "@catanarchy/engine";
import {
  createFirstLegalAgent,
  runGameSteps,
  type AgentNegotiationRequest,
  type AgentResume,
  type MatchActivity,
  type MatchRunResult,
  type NegotiationPolicy,
  type SeatAgent,
} from "@catanarchy/harness";
import type { GameConfig, NegotiationAction, ResourceCounts } from "@catanarchy/protocol";
import {
  readRunPackage,
  RunRecorder,
  type CreateRunRecorderOptions,
  type InitialStateOrigin,
  type RunRecord,
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

const RESOURCE_KEYS = ["lumber", "brick", "wool", "grain", "ore"] as const;
const NO_RESOURCES: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };

const canPay = (held: ResourceCounts, cost: ResourceCounts): boolean =>
  RESOURCE_KEYS.every((key) => held[key] >= cost[key]);

const acceptDirectedOffer = (
  held: ResourceCounts,
  request: AgentNegotiationRequest,
): NegotiationAction | null => {
  const directed = request.negotiation.offers.find(
    (offer) => offer.status === "open" && offer.targetPlayerId === request.playerId,
  );
  if (directed === undefined || !canPay(held, directed.receive)) return null;
  return { type: "accept-offer", offerId: directed.id };
};

const offerFromTurnPlayer = (
  held: ResourceCounts,
  request: AgentNegotiationRequest,
  attempt: number,
): NegotiationAction => {
  const mine = request.negotiation.offers.some(
    (offer) => offer.status === "open" && offer.proposerPlayerId === request.playerId,
  );
  if (mine || request.playerId !== request.turnPlayerId) return { type: "pass" };
  const giveKey = RESOURCE_KEYS.find((key) => held[key] > 0);
  if (giveKey === undefined) return { type: "pass" };
  const candidates = RESOURCE_KEYS.filter((key) => key !== giveKey);
  const receiveKey = candidates[attempt % candidates.length];
  const others = config.players.filter(({ id }) => id !== request.playerId);
  const target = others[Math.floor(attempt / candidates.length) % others.length];
  if (receiveKey === undefined || target === undefined) return { type: "pass" };
  return {
    type: "make-offer",
    targetPlayerId: target.id,
    scope: { type: "public" },
    give: { ...NO_RESOURCES, [giveKey]: 1 },
    receive: { ...NO_RESOURCES, [receiveKey]: 1 },
  };
};

/**
 * One scripted negotiating action per window. The turn player offers one card of
 * a resource it holds for one card of another resource, and every other seat
 * accepts an offer it can pay for. The choice cycles over targets and resources,
 * so a trade lands after a few turns without reading another seat's hand.
 */
const tradingAction = (request: AgentNegotiationRequest, attempt: number): NegotiationAction => {
  const held = request.observation.ownResources ?? NO_RESOURCES;
  return acceptDirectedOffer(held, request) ?? offerFromTurnPlayer(held, request, attempt);
};

const createTradingAgent = (): SeatAgent => {
  const base = createFirstLegalAgent();
  let attempt = 0;
  return {
    decide: (request) => base.decide(request),
    cancel: () => base.cancel(),
    dispose: () => base.dispose(),
    negotiate: async (request) => {
      const action = tradingAction(request, attempt);
      attempt += 1;
      return { action, reason: `scripted ${action.type}` };
    },
  };
};

/**
 * Play until the stop condition matches. The sink writes the activity first and
 * throws after it, so the run stops exactly at that record and keeps every
 * record before it.
 */
const playUntil = async (
  recorder: RunRecorder,
  stop: (activity: MatchActivity) => boolean,
  options: PlayOptions,
  createAgent: () => SeatAgent = createFirstLegalAgent,
): Promise<unknown> =>
  Effect.runPromise(
    runGameSteps({
      config,
      maxDecisions: options.maxDecisions,
      createAgent: async () => createAgent(),
      onActivity: async (activity) => {
        await recorder.recordActivity(activity);
        if (stop(activity)) throw new Error("scripted stop");
      },
      ...(options.policy === undefined ? {} : { negotiationPolicy: options.policy }),
    }),
  ).then(
    () => null,
    (error: unknown) => error,
  );

const windowTurns = (records: ReadonlyArray<RunRecord>): ReadonlyArray<number> =>
  records.flatMap((record) => {
    if (record.kind !== "negotiation.event") return [];
    const { event } = record.payload;
    return event.type === "negotiation.window-opened" ? [event.turn] : [];
  });

const recordKinds = (directory: string): Promise<ReadonlyArray<string>> =>
  readRunPackage(directory).then((pkg) => pkg.records.map(({ kind }) => kind));

const gameEvents = (directory: string): Promise<ReadonlyArray<unknown>> =>
  readRunPackage(directory).then((pkg) =>
    pkg.records.flatMap((record) => (record.kind === "game.event" ? [record.payload] : [])),
  );

const timelineText = (directory: string): Promise<string> =>
  readFile(resolve(directory, "timeline.jsonl"), "utf8");

const timelineLines = async (directory: string): Promise<ReadonlyArray<string>> =>
  (await timelineText(directory)).trimEnd().split("\n");

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

const appendRecord = async (
  directory: string,
  payload: unknown,
  kind: RunRecord["kind"] = "negotiation.decision",
): Promise<void> => {
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
      kind,
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
    expect(after.resume?.nextIndex).toBe(after.records.length - 1);

    // A resume that completes no command is replaced by the next one instead of
    // growing the log, so the seam stays the first record after the prefix.
    const reopened = await RunRecorder.open({
      directory,
      mode: "cold",
      reason: "operator stopped the run again",
    });
    await reopened.recorder.close();
    const reread = await readRunPackage(directory);
    expect(reread.records).toHaveLength(after.records.length);
    expect(reread.records.at(-1)).toMatchObject({ kind: "run.resumed" });
  });

  it("continues the offset sequence of a long run after a resume", async () => {
    const directory = await temporaryRunDirectory("offsets");
    const recorder = await startRun(directory, "run-offsets");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();

    // A long run reaches an offset far beyond the runtime of the resumed process, so
    // a baseline that restarts at zero would report every resumed record at one time.
    const stored = await readRunPackage(directory);
    await rewriteTimeline(directory, (records) => {
      for (const record of records) {
        record["offsetMs"] = (record["offsetMs"] as number) + 5_000_000;
      }
    });
    const lastOffset = (stored.records.at(-1)?.offsetMs ?? 0) + 5_000_000;

    let now = 1_000_000;
    const opened = await RunRecorder.open({
      directory,
      mode: "cold",
      reason: "offsets",
      clock: {
        monotonicMs: () => (now += 250),
        utcNow: () => new Date(1_789_012_800_000 + now),
      },
    });
    await play(opened.recorder, {
      maxDecisions: opened.resume.decisionCount + 2,
      resume: agentResume(opened.resume),
    });
    await opened.recorder.close();

    const after = await readRunPackage(directory);
    const resumed = after.records.filter(({ index }) => index >= opened.resume.nextIndex);
    expect(resumed.length).toBeGreaterThan(1);
    expect(resumed.every(({ offsetMs }) => offsetMs >= lastOffset)).toBe(true);
    expect(new Set(resumed.map(({ offsetMs }) => offsetMs)).size).toBeGreaterThan(1);
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

  it("refuses a timeline that ends with a terminal record", async () => {
    const directory = await temporaryRunDirectory("terminal-tail");
    const recorder = await startRun(directory, "run-terminal-tail");
    await play(recorder, { maxDecisions: 2 });
    // A process can die between the terminal append and the manifest write, so the
    // manifest still says partial while the timeline is already final.
    await appendRecord(
      directory,
      { gameSequence: 1, negotiationSequence: -1, winnerPlayerId: null },
      "run.completed",
    );
    await recorder.close();

    const before = await readRunPackage(directory);
    expect(before.manifest.status).toBe("partial");
    expect(before.resumeBlockedReason).toMatch(/terminal record/u);
    const text = await timelineText(directory);
    await expect(
      RunRecorder.open({ directory, mode: "cold", reason: "terminal tail" }),
    ).rejects.toThrow(/cannot resume/u);
    expect(await timelineText(directory)).toBe(text);
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
    expect((await readdir(directory)).filter((name) => name.includes("takeover"))).toEqual([]);
  });

  it("waits for another taker before it clears a stale lock", async () => {
    const directory = await temporaryRunDirectory("stale-contest");
    const recorder = await startRun(directory, "run-stale-contest");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();

    // One process may take over a stale lock. A second taker must leave the lock alone
    // instead of removing the lock that the first taker has already claimed.
    await writeFile(resolve(directory, "run.lock"), "999999999\n", "utf8");
    await link(resolve(directory, "run.lock"), resolve(directory, "run.lock.999999999.takeover"));
    await expect(RunRecorder.open({ directory, mode: "cold", reason: "contest" })).rejects.toThrow(
      /run lock/u,
    );
    expect(await readFile(resolve(directory, "run.lock"), "utf8")).toBe("999999999\n");
  });

  it("treats an unreadable lock as held", async () => {
    const directory = await temporaryRunDirectory("empty-lock");
    const recorder = await startRun(directory, "run-empty-lock");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();

    await writeFile(resolve(directory, "run.lock"), "", "utf8");
    await expect(
      RunRecorder.open({ directory, mode: "cold", reason: "empty lock" }),
    ).rejects.toThrow(/run lock/u);
    expect(await readFile(resolve(directory, "run.lock"), "utf8")).toBe("");
  });

  it("keeps a lock that another writer replaced", async () => {
    const directory = await temporaryRunDirectory("foreign-lock");
    const recorder = await startRun(directory, "run-foreign-lock");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();

    const opened = await RunRecorder.open({ directory, mode: "cold", reason: "first" });
    await writeFile(resolve(directory, "run.lock"), "999999999\n", "utf8");
    await opened.recorder.close();
    expect(await readFile(resolve(directory, "run.lock"), "utf8")).toBe("999999999\n");
  });

  it("takes the lock before it reads the resumable package", async () => {
    const directory = await temporaryRunDirectory("lock-order");
    const recorder = await startRun(directory, "run-lock-order");
    const result = await play(recorder, { maxDecisions: 2 });
    await recorder.complete(result);

    // A terminal run is refused by the package read. The lock is checked first, so
    // a live holder wins even when the stored run could not resume.
    await writeFile(resolve(directory, "run.lock"), `${process.pid}\n`, "utf8");
    await expect(RunRecorder.open({ directory, mode: "cold", reason: "ordering" })).rejects.toThrow(
      /run lock/u,
    );
  });

  it("refuses a run directory that does not exist", async () => {
    const directory = await temporaryRunDirectory("absent");
    await expect(RunRecorder.open({ directory, mode: "cold", reason: "absent" })).rejects.toThrow(
      /does not exist/u,
    );
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
    await play(recorder, { maxDecisions: 14, policy: negotiationPolicy });
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
      maxDecisions: 18,
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

  it("carries the spend of a discarded tail into a later resume", async () => {
    const directory = await temporaryRunDirectory("carried-spend");
    const recorder = await startRun(directory, "run-carried-spend");
    await play(recorder, { maxDecisions: 2 });
    await recorder.close();

    await appendRecord(directory, {
      matchId: config.matchId,
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.5 },
    });

    const opened = await RunRecorder.open({ directory, mode: "cold", reason: "carried spend" });
    expect(opened.resume.observedSpendUsd).toBeCloseTo(0.5, 10);
    const seam = (await readRunPackage(directory)).records.at(-1);
    expect(seam).toMatchObject({ kind: "run.resumed", payload: { priorSpendUsd: 0.5 } });

    const resumed = await play(opened.recorder, {
      maxDecisions: opened.resume.decisionCount + 2,
      resume: agentResume(opened.resume),
    });
    await opened.recorder.close();
    expect(resumed.state.sequence).toBeGreaterThan(0);

    const second = await readRunPackage(directory);
    expect(second.records.filter(({ kind }) => kind === "run.resumed")).toHaveLength(1);
    expect(second.resume?.observedSpendUsd).toBeCloseTo(0.5, 10);
  });

  it("counts only the decisions the prefix committed", async () => {
    const directory = await temporaryRunDirectory("tail-decision");
    const recorder = await startRun(directory, "run-tail-decision");
    await play(recorder, { maxDecisions: 3 });
    await recorder.close();

    const stored = await readRunPackage(directory);
    const lastDecision = stored.records.findLast((record) => record.kind === "game.decision");
    if (lastDecision === undefined) throw new Error("Expected a stored decision.");
    // A stop between a decision and its command marker leaves that decision in the file.
    await appendRecord(directory, lastDecision.payload, "game.decision");

    const before = await readRunPackage(directory);
    const nextIndex = before.resume?.nextIndex ?? -1;
    const committed = before.records.filter(
      (record) => record.index < nextIndex && record.kind === "game.decision",
    ).length;
    expect(before.records.at(-1)?.kind).toBe("game.decision");
    expect(committed).toBeGreaterThan(0);
    expect(before.records.length - nextIndex).toBe(1);
    expect(before.resume?.decisionCount).toBe(committed);
  });

  it("reads the negotiation policy from the whole stored timeline", async () => {
    const directory = await temporaryRunDirectory("policy-tail");
    const recorder = await startRun(directory, "run-policy-tail");
    let windows = 0;
    const stopped = await playUntil(
      recorder,
      (activity) => {
        if (activity.kind !== "negotiation.event") return false;
        if (activity.payload.event.type !== "negotiation.window-opened") return false;
        windows += 1;
        return windows === 1;
      },
      { maxDecisions: 40, policy: negotiationPolicy },
    );
    expect(stopped).toBeInstanceOf(Error);
    await recorder.close();

    // The only window record is in the discarded tail, so the stored prefix holds no
    // window at all. The policy must therefore come from the whole timeline.
    const before = await readRunPackage(directory);
    expect(before.resume?.negotiations).toEqual([]);
    expect(before.resume?.negotiationMaxRounds).toBe(negotiationPolicy.maxRounds);
    expect(before.resume?.nextIndex).toBeLessThan(before.records.length);
  });

  it("resumes a run that stopped inside a negotiation window", async () => {
    const directory = await temporaryRunDirectory("open-window");
    const recorder = await startRun(directory, "run-open-window");
    let windows = 0;
    const stopped = await playUntil(
      recorder,
      (activity) => {
        if (activity.kind !== "negotiation.event") return false;
        if (activity.payload.event.type !== "negotiation.window-opened") return false;
        windows += 1;
        return windows === 3;
      },
      { maxDecisions: 40, policy: negotiationPolicy },
    );
    expect(stopped).toBeInstanceOf(Error);
    await recorder.close();

    const before = await readRunPackage(directory);
    const boundary = before.records.findLastIndex(({ kind }) => kind === "game.command-completed");
    expect(before.records.at(-1)?.kind).toBe("negotiation.event");
    expect(before.resumeBlockedReason).toBeNull();
    expect(before.resume?.nextIndex).toBe(boundary + 1);
    expect(before.resume?.negotiations.at(-1)?.event.type).toBe("negotiation.window-closed");

    const seam = await RunRecorder.open({ directory, mode: "cold", reason: "open window" });
    const resumed = await play(seam.recorder, {
      maxDecisions: seam.resume.decisionCount + 2,
      policy: negotiationPolicy,
      resume: agentResume(seam.resume),
    });
    await seam.recorder.complete(resumed);

    const finished = await readRunPackage(directory);
    expect(finished.manifest.status).toBe("completed");
    expect(finished.records.map(({ index }) => index)).toEqual(
      finished.records.map((_record, index) => index),
    );
    // The half-played window is gone, so the file holds exactly one line per record.
    expect(await timelineLines(directory)).toHaveLength(finished.records.length);
    const turns = windowTurns(finished.records);
    expect(turns.length).toBeGreaterThan(2);
    expect(new Set(turns).size).toBe(turns.length);
  });

  it("refuses a resume that stopped at an accepted trade", async () => {
    const directory = await temporaryRunDirectory("trade");
    const recorder = await startRun(directory, "run-trade");
    const stopped = await playUntil(
      recorder,
      (activity) =>
        activity.kind === "game.command-completed" &&
        activity.payload.commandId.includes(":settle:"),
      { maxDecisions: 60, policy: negotiationPolicy },
      createTradingAgent,
    );
    expect(stopped).toBeInstanceOf(Error);
    await recorder.close();

    const before = await readRunPackage(directory);
    expect(before.records.at(-1)?.kind).toBe("game.command-completed");
    expect(before.resume).toBeNull();
    expect(before.resumeBlockedReason).toMatch(/open negotiation window/u);

    const bytes = await timelineText(directory);
    await expect(RunRecorder.open({ directory, mode: "cold", reason: "trade" })).rejects.toThrow(
      /open negotiation window/u,
    );
    expect(await timelineText(directory)).toBe(bytes);
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
