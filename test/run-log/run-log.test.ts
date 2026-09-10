import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { replay, STANDARD_BOARD_GENERATOR_ID } from "@catanarchy/engine";
import { createFirstLegalAgent, runGameSteps } from "@catanarchy/harness";
import type { GameConfig } from "@catanarchy/protocol";
import { parseRunRecord, readRunPackage, RunRecorder, type RunClock } from "@catanarchy/run-log";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "recorded-match",
  seed: 42,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
  ],
};

const initialStateOrigin = {
  type: "generated" as const,
  generatorId: STANDARD_BOARD_GENERATOR_ID,
  seed: config.seed,
};

const temporaryRunDirectory = async (): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "catanarchy-run-log-"));
  roots.push(root);
  return resolve(root, "run-42");
};

const clock = (): RunClock => {
  let elapsed = 0;
  return {
    monotonicMs: () => {
      elapsed += 5;
      return elapsed;
    },
    utcNow: () => new Date(1_789_012_800_000 + elapsed),
  };
};

const storedLayout = (records: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> => {
  const created = records.find(({ kind }) => kind === "game.event");
  const payload = created?.["payload"] as Record<string, unknown> | undefined;
  const event = payload?.["event"] as Record<string, unknown> | undefined;
  const state = event?.["state"] as Record<string, unknown> | undefined;
  const layout = state?.["layout"];
  if (typeof layout !== "object" || layout === null) {
    throw new Error("Expected a generated starting board.");
  }
  return layout as Record<string, unknown>;
};

const swapTwoTerrainKinds = (terrain: Array<Record<string, unknown>>): void => {
  const leftIndex = terrain.findIndex(({ terrain: value }) => value !== "desert");
  const leftKind = terrain[leftIndex]?.["terrain"];
  const rightIndex = terrain.findIndex(
    ({ terrain: value }, index) => index > leftIndex && value !== "desert" && value !== leftKind,
  );
  const left = terrain[leftIndex];
  const right = terrain[rightIndex];
  if (left === undefined || right === undefined) throw new Error("Expected two terrain kinds.");
  [left["terrain"], right["terrain"]] = [right["terrain"], left["terrain"]];
};

const changeStoredTerrainShuffle = async (directory: string): Promise<void> => {
  const timelinePath = resolve(directory, "timeline.jsonl");
  const records = (await readFile(timelinePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const layout = storedLayout(records);
  const terrain = structuredClone(layout["terrain"]) as Array<Record<string, unknown>>;
  swapTwoTerrainKinds(terrain);
  layout["terrain"] = terrain;
  await writeFile(timelinePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("run log", () => {
  it("records a chronological match that replays to the same state", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-42",
      config,
      initialStateOrigin,
      seats: config.players.map(({ id }) => ({
        seatId: id,
        agentType: "scripted" as const,
        model: null,
      })),
      clock: clock(),
    });
    const result = await Effect.runPromise(
      runGameSteps({
        config,
        maxDecisions: 2,
        createAgent: async () => createFirstLegalAgent(),
        onActivity: async (activity) => recorder.recordActivity(activity),
      }),
    );
    await recorder.complete(result);

    const saved = await readRunPackage(directory);
    expect(saved.manifest.status).toBe("completed");
    expect(saved.manifest.initialStateOrigin).toEqual(initialStateOrigin);
    expect(saved.verification).toEqual({
      generatorMatch: "matches-current",
      commandVerification: "exact",
    });
    expect(saved.records[0]?.offsetMs).toBe(0);
    expect(saved.records.map(({ index }) => index)).toEqual(
      saved.records.map((_record, index) => index),
    );
    expect(saved.records.map(({ offsetMs }) => offsetMs).toSorted((a, b) => a - b)).toEqual(
      saved.records.map(({ offsetMs }) => offsetMs),
    );
    expect(saved.records.filter(({ kind }) => kind === "game.agent-requested")).toHaveLength(2);
    expect(saved.records.filter(({ kind }) => kind === "game.decision")).toHaveLength(2);
    expect(saved.records.filter(({ kind }) => kind === "game.command-completed")).toHaveLength(3);
    const events = saved.records.flatMap((record) =>
      record.kind === "game.event" ? [record.payload] : [],
    );
    expect(await Effect.runPromise(replay(events))).toEqual(result.state);
  });

  it("reports a valid stored board that differs from the current generator", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-different-board",
      config,
      initialStateOrigin,
      seats: config.players.map(({ id }) => ({
        seatId: id,
        agentType: "scripted" as const,
        model: null,
      })),
      clock: clock(),
    });
    const result = await Effect.runPromise(
      runGameSteps({
        config,
        maxDecisions: 1,
        createAgent: async () => createFirstLegalAgent(),
        onActivity: async (activity) => recorder.recordActivity(activity),
      }),
    );
    await recorder.complete(result);

    await changeStoredTerrainShuffle(directory);

    await expect(readRunPackage(directory)).resolves.toMatchObject({
      verification: {
        generatorMatch: "differs-from-current",
        commandVerification: "exact",
      },
    });
  });

  it("marks native generator checks as not applicable for an observed origin", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-observed",
      config,
      initialStateOrigin: { type: "observed", adapterId: "test-adapter" },
      seats: config.players.map(({ id }) => ({
        seatId: id,
        agentType: "scripted" as const,
        model: null,
      })),
      clock: clock(),
    });
    const result = await Effect.runPromise(
      runGameSteps({
        config,
        maxDecisions: 1,
        createAgent: async () => createFirstLegalAgent(),
        onActivity: async (activity) => recorder.recordActivity(activity),
      }),
    );
    await recorder.complete(result);

    const saved = await readRunPackage(directory);
    expect(saved.verification).toEqual({
      generatorMatch: "not-applicable",
      commandVerification: "not-applicable",
    });
  });

  it("maps a Pi seat to a native session file inside the run", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-pi",
      config,
      initialStateOrigin,
      seats: config.players.map(({ id }, index) => ({
        seatId: id,
        agentType: index === 0 ? ("pi" as const) : ("scripted" as const),
        model: index === 0 ? { provider: "test", modelId: "model" } : null,
      })),
      piVersion: "test-version",
      clock: clock(),
    });
    const sessionFile = resolve(recorder.sessionsDirectory, "red.jsonl");

    await recorder.registerPiSession("red", { sessionId: "session-red", sessionFile });

    expect(recorder.manifest.seats[0]).toMatchObject({
      seatId: "red",
      sessionId: "session-red",
      sessionFile: "sessions/red.jsonl",
    });
    await expect(
      recorder.registerPiSession("red", {
        sessionId: "outside",
        sessionFile: resolve(directory, "..", "outside.jsonl"),
      }),
    ).rejects.toThrow("outside the run sessions directory");
    await recorder.cancel(null, "test finished");
  });

  it("marks a failed run and stores only the short supplied reason", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-failed",
      config,
      initialStateOrigin,
      seats: config.players.map(({ id }) => ({
        seatId: id,
        agentType: "scripted" as const,
        model: null,
      })),
      clock: clock(),
    });

    await recorder.fail(null, "  model   request failed  ");

    const saved = await readRunPackage(directory);
    expect(saved.manifest.status).toBe("failed");
    expect(saved.records.at(-1)).toMatchObject({
      kind: "run.failed",
      payload: { reason: "model request failed" },
    });
  });

  it("rejects invalid records, order, and terminal status", async () => {
    expect(() => parseRunRecord({ schema: "wrong" })).toThrow("run record is invalid");
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-invalid",
      config,
      initialStateOrigin,
      seats: config.players.map(({ id }) => ({
        seatId: id,
        agentType: "scripted" as const,
        model: null,
      })),
      clock: clock(),
    });
    await recorder.cancel(null, "test finished");
    const path = resolve(directory, "timeline.jsonl");
    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    records[1] = { ...records[1], index: 9 };
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await expect(readRunPackage(directory)).rejects.toThrow("timeline order");

    records[1] = { ...records[1], index: 1 };
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const manifestPath = resolve(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, status: "completed" })}\n`);
    await expect(readRunPackage(directory)).rejects.toThrow("terminal record");

    await writeFile(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        initialStateOrigin: { ...initialStateOrigin, seed: config.seed + 1 },
      })}\n`,
    );
    await expect(readRunPackage(directory)).rejects.toThrow("origin seed");

    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, status: "partial" })}\n`);
    await expect(readRunPackage(directory)).rejects.toThrow("run manifest is invalid");

    const seats = manifest["seats"] as ReadonlyArray<Record<string, unknown>>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, seats: [seats[0], seats[0]] })}\n`,
    );
    await expect(readRunPackage(directory)).rejects.toThrow("run manifest is invalid");
  });

  it("rejects corrupt game events and permits only a partial unmarked tail", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-game-validation",
      config,
      initialStateOrigin,
      seats: config.players.map(({ id }) => ({
        seatId: id,
        agentType: "scripted" as const,
        model: null,
      })),
      clock: clock(),
    });
    const result = await Effect.runPromise(
      runGameSteps({
        config,
        maxDecisions: 1,
        createAgent: async () => createFirstLegalAgent(),
        onActivity: async (activity) => recorder.recordActivity(activity),
      }),
    );
    await recorder.complete(result);

    const timelinePath = resolve(directory, "timeline.jsonl");
    const manifestPath = resolve(directory, "manifest.json");
    const original = (await readFile(timelinePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const eventIndex = original.findLastIndex(({ kind }) => kind === "game.event");
    const eventRecord = original[eventIndex];
    if (eventRecord === undefined || typeof eventRecord["payload"] !== "object") {
      throw new Error("The test run has no game event.");
    }
    const payload = eventRecord["payload"] as Record<string, unknown>;
    const event = payload["event"] as Record<string, unknown>;
    const writeRecords = async (records: ReadonlyArray<Record<string, unknown>>): Promise<void> =>
      writeFile(timelinePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const malformed = original.with(eventIndex, {
      ...eventRecord,
      payload: { ...payload, event: { ...event, type: "not-a-game-event" } },
    });
    await writeRecords(malformed);
    await expect(readRunPackage(directory)).rejects.toThrow("malformed game event");

    const wrongMatch = original.with(eventIndex, {
      ...eventRecord,
      payload: { ...payload, matchId: "another-match" },
    });
    await writeRecords(wrongMatch);
    await expect(readRunPackage(directory)).rejects.toThrow("invalid game event identity");

    if (event["type"] !== "settlement.placed") {
      throw new Error("The test run did not end with a settlement placement.");
    }
    const nonReplayable = original.with(eventIndex, {
      ...eventRecord,
      payload: { ...payload, event: { ...event, vertexId: "v:999:999" } },
    });
    await writeRecords(nonReplayable);
    await expect(readRunPackage(directory)).rejects.toThrow("cannot replay");

    const markerIndex = original.findLastIndex(({ kind }) => kind === "game.command-completed");
    const withoutLastMarker = original
      .filter((_record, index) => index !== markerIndex)
      .map((record, index): Record<string, unknown> => ({ ...record, index }));
    await writeRecords(withoutLastMarker);
    await expect(readRunPackage(directory)).rejects.toThrow("inside an atomic command batch");

    const partialRecords = withoutLastMarker
      .filter(({ kind }) => kind !== "run.completed")
      .map((record, index): Record<string, unknown> => ({ ...record, index }));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, status: "partial", finishedAt: null })}\n`,
    );
    const foreignTail = partialRecords.with(eventIndex, {
      ...eventRecord,
      index: eventIndex,
      payload: { ...payload, matchId: "another-match" },
    });
    await writeRecords(foreignTail);
    await expect(readRunPackage(directory)).rejects.toThrow("invalid game event identity");

    await writeRecords(partialRecords);
    await expect(readRunPackage(directory)).resolves.toMatchObject({
      manifest: { status: "partial" },
    });
  });

  it("validates negotiation event payloads, identities, and sequences", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-negotiation-validation",
      config,
      initialStateOrigin,
      seats: config.players.map(({ id }) => ({
        seatId: id,
        agentType: "scripted" as const,
        model: null,
      })),
      clock: clock(),
    });
    await recorder.recordActivity({
      kind: "negotiation.event",
      payload: {
        schema: "catanarchy.negotiation-event.v1",
        matchId: config.matchId,
        sequence: 0,
        gameSequence: 0,
        event: {
          type: "negotiation.window-opened",
          windowId: "window-1",
          turn: 1,
          turnPlayerId: "red",
          maxRounds: 1,
        },
      },
    });
    await recorder.cancel(null, "test finished");
    await expect(readRunPackage(directory)).resolves.toMatchObject({
      manifest: { status: "cancelled" },
    });

    const timelinePath = resolve(directory, "timeline.jsonl");
    const records = (await readFile(timelinePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const eventIndex = records.findIndex(({ kind }) => kind === "negotiation.event");
    const eventRecord = records[eventIndex];
    if (eventRecord === undefined || typeof eventRecord["payload"] !== "object") {
      throw new Error("The test run has no negotiation event.");
    }
    const payload = eventRecord["payload"] as Record<string, unknown>;
    const writeRecords = async (next: ReadonlyArray<Record<string, unknown>>): Promise<void> =>
      writeFile(timelinePath, `${next.map((record) => JSON.stringify(record)).join("\n")}\n`);

    await writeRecords(
      records.with(eventIndex, {
        ...eventRecord,
        payload: { ...payload, matchId: "another-match" },
      }),
    );
    await expect(readRunPackage(directory)).rejects.toThrow("invalid negotiation event identity");

    await writeRecords(
      records.with(eventIndex, {
        ...eventRecord,
        payload: { ...payload, event: { type: "unknown-event" } },
      }),
    );
    await expect(readRunPackage(directory)).rejects.toThrow("malformed negotiation event");
  });

  it("ignores an incomplete final line while a writer is appending", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-partial-read",
      config,
      initialStateOrigin,
      seats: config.players.map(({ id }) => ({
        seatId: id,
        agentType: "scripted" as const,
        model: null,
      })),
      clock: clock(),
    });
    await recorder.cancel(null, "test finished");
    await appendFile(resolve(directory, "timeline.jsonl"), '{"unfinished":', "utf8");

    const saved = await readRunPackage(directory);

    expect(saved.records.at(-1)?.kind).toBe("run.cancelled");
    expect(await readFile(resolve(directory, "manifest.json"), "utf8")).toContain('"cancelled"');
  });
});
