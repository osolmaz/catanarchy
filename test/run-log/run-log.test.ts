import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { replay } from "@catanarchy/engine";
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

  it("maps a Pi seat to a native session file inside the run", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-pi",
      config,
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

    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, status: "partial" })}\n`);
    await expect(readRunPackage(directory)).rejects.toThrow("run manifest is invalid");

    const seats = manifest["seats"] as ReadonlyArray<Record<string, unknown>>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, seats: [seats[0], seats[0]] })}\n`,
    );
    await expect(readRunPackage(directory)).rejects.toThrow("run manifest is invalid");
  });

  it("ignores an incomplete final line while a writer is appending", async () => {
    const directory = await temporaryRunDirectory();
    const recorder = await RunRecorder.create({
      directory,
      runId: "run-partial-read",
      config,
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
