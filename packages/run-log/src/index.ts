import { Buffer } from "node:buffer";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep as platformSeparator } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { matchesCurrentGenerator, replay, verifyNativeReplay } from "@catanarchy/engine";
import type { AgentModelIdentity, MatchActivity, MatchRunResult } from "@catanarchy/harness";
import {
  decodeGameConfig,
  decodeGameEventEnvelope,
  decodeNegotiationEvent,
  type GameConfig,
  type GameEvent,
  type GameState,
  type NegotiationEvent,
  type PlayerId,
} from "@catanarchy/protocol";
import { Effect } from "effect";

export const RUN_MANIFEST_SCHEMA = "catanarchy.run-manifest.v1" as const;
export const RUN_RECORD_SCHEMA = "catanarchy.run-record.v1" as const;

export type RunStatus = "partial" | "completed" | "failed" | "cancelled";

export type InitialStateOrigin =
  | {
      readonly type: "generated";
      readonly generatorId: string;
      readonly seed: number;
    }
  | {
      readonly type: "observed";
      readonly adapterId: string;
    };

export type GeneratorMatch =
  | "matches-current"
  | "differs-from-current"
  | "not-applicable"
  | "pending";
export type CommandVerification = "exact" | "not-applicable" | "pending";

export interface RunVerification {
  readonly generatorMatch: GeneratorMatch;
  readonly commandVerification: CommandVerification;
}

export interface RunSeatManifest {
  readonly seatId: PlayerId;
  readonly agentType: "pi" | "scripted";
  readonly model: AgentModelIdentity | null;
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
}

export interface RunManifest {
  readonly schema: typeof RUN_MANIFEST_SCHEMA;
  readonly runId: string;
  readonly matchId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly timeline: "timeline.jsonl";
  readonly timing: "monotonic";
  readonly piVersion: string | null;
  readonly initialStateOrigin: InitialStateOrigin;
  readonly seats: ReadonlyArray<RunSeatManifest>;
}

export type RunVisibility =
  | "public"
  | "referee"
  | { readonly type: "seat"; readonly seatId: string };

interface RunRecordBase {
  readonly schema: typeof RUN_RECORD_SCHEMA;
  readonly runId: string;
  readonly index: number;
  readonly offsetMs: number;
  readonly recordedAt: string;
  readonly visibility: RunVisibility;
}

type ActivityRunRecord = {
  [Activity in MatchActivity as Activity["kind"]]: RunRecordBase & Activity;
}[MatchActivity["kind"]];

export interface RunStartedRecord extends RunRecordBase {
  readonly kind: "run.started";
  readonly payload: { readonly config: GameConfig };
}

export interface RunCompletedRecord extends RunRecordBase {
  readonly kind: "run.completed";
  readonly payload: RunTerminalSummary;
}

export interface RunFailedRecord extends RunRecordBase {
  readonly kind: "run.failed";
  readonly payload: RunTerminalSummary & { readonly reason: string };
}

export interface RunCancelledRecord extends RunRecordBase {
  readonly kind: "run.cancelled";
  readonly payload: RunTerminalSummary & { readonly reason: string };
}

export type RunResumeMode = "warm" | "cold";

export interface RunResumedRecord extends RunRecordBase {
  readonly kind: "run.resumed";
  readonly payload: {
    readonly mode: RunResumeMode;
    readonly resumedAtIndex: number;
    readonly replayedSequence: number;
    readonly verification: CommandVerification;
    readonly reason: string;
    /**
     * Spend that an earlier attempt already incurred and that this resume removes
     * from the timeline. The seam carries it, so the whole-run ceiling still counts it.
     */
    readonly priorSpendUsd: number;
  };
}

export type RunRecord =
  | RunStartedRecord
  | ActivityRunRecord
  | RunCompletedRecord
  | RunFailedRecord
  | RunCancelledRecord
  | RunResumedRecord;

export interface RunTerminalSummary {
  readonly gameSequence: number;
  readonly negotiationSequence: number;
  readonly winnerPlayerId: PlayerId | null;
}

/**
 * Everything needed to continue a stopped run. The timeline is the state, so a
 * resume reads the stored prefix and then appends to the same log.
 */
export interface RunResume {
  readonly config: GameConfig;
  /** The state after replaying the stored prefix. */
  readonly state: GameState;
  /** The game events of the stored prefix, in order. */
  readonly events: ReadonlyArray<GameEvent>;
  /** Raw envelopes of the stored prefix. The prefix ends at a completed command. */
  readonly eventPayloads: ReadonlyArray<unknown>;
  /** The negotiation events of the stored prefix. A half-played window is not one of them. */
  readonly negotiations: ReadonlyArray<NegotiationEvent>;
  readonly decisionCount: number;
  readonly observedSpendUsd: number;
  /** The record index the resume continues from. Records after it are dropped. */
  readonly nextIndex: number;
  readonly lastOffsetMs: number;
  readonly replayedSequence: number;
  readonly verification: CommandVerification;
}

export interface RunPackage {
  readonly manifest: RunManifest;
  readonly records: ReadonlyArray<RunRecord>;
  readonly verification: RunVerification;
  /** Null when the run is terminal, or when no command ever completed. */
  readonly resume: RunResume | null;
  /** Why the stored prefix cannot resume, or null when it can. */
  readonly resumeBlockedReason: string | null;
}

export interface RunClock {
  monotonicMs(): number;
  utcNow(): Date;
}

export interface CreateRunRecorderOptions {
  readonly directory: string;
  readonly runId: string;
  readonly config: GameConfig;
  readonly initialStateOrigin: InitialStateOrigin;
  readonly seats: ReadonlyArray<{
    readonly seatId: PlayerId;
    readonly agentType: RunSeatManifest["agentType"];
    readonly model: AgentModelIdentity | null;
  }>;
  readonly piVersion?: string;
  readonly clock?: RunClock;
}

export interface OpenRunRecorderOptions {
  readonly directory: string;
  readonly mode: RunResumeMode;
  readonly reason: string;
  readonly clock?: RunClock;
}

export interface OpenedRun {
  readonly recorder: RunRecorder;
  readonly resume: RunResume;
  /** Absolute session files restored for a warm resume. Empty in cold mode. */
  readonly sessions: ReadonlyMap<string, string>;
}

const systemClock = (): RunClock => ({
  monotonicMs: () => performance.now(),
  utcNow: () => new Date(),
});

const terminalSummary = (result: MatchRunResult): RunTerminalSummary => ({
  gameSequence: result.state.sequence,
  negotiationSequence: result.negotiations.at(-1)?.sequence ?? -1,
  winnerPlayerId: result.state.result?.winnerId ?? null,
});

const visibilityFor = (activity: MatchActivity): RunVisibility => {
  switch (activity.kind) {
    case "game.agent-requested":
    case "negotiation.agent-requested":
      return { type: "seat", seatId: activity.payload.request.playerId };
    default:
      return "referee";
  }
};

const safeReason = (reason: string): string => reason.replaceAll(/\s+/gu, " ").trim().slice(0, 300);

const LOCK_FILE = "run.lock";

const lockHolderPid = async (path: string): Promise<number | null> => {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { readonly code?: string }).code === "EPERM";
  }
};

/** Refuse a stored package that cannot continue from its own timeline. */
const assertResumable = (directory: string, pkg: RunPackage): RunResume => {
  if (pkg.manifest.status !== "partial") {
    throw new Error(`The run at ${directory} is ${pkg.manifest.status} and cannot resume.`);
  }
  if (pkg.resumeBlockedReason !== null) {
    throw new Error(`The run at ${directory} cannot resume. ${pkg.resumeBlockedReason}`);
  }
  const resume = pkg.resume;
  if (resume === null) {
    throw new Error(`The run at ${directory} has no completed command to resume from.`);
  }
  return resume;
};

/**
 * A live run holds `run.lock`. The file is a transient runtime guard and not part
 * of the run package. The lock is claimed by linking a fully written candidate, so
 * it never appears empty. A lock with a live holder is refused, a lock with a dead
 * holder is taken over, and a lock that cannot be read counts as held.
 */
const acquireRunLock = async (directory: string): Promise<() => Promise<void>> => {
  const path = resolve(directory, LOCK_FILE);
  const staged = `${path}.${process.pid}.staged`;
  await rm(staged, { force: true });
  await writeFile(staged, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await claimRunLock(staged, path)) return async () => releaseRunLock(path);
      const holder = await lockHolderPid(path);
      if (holder === null || processIsAlive(holder)) {
        throw new Error(`Another process holds the run lock at ${path}.`);
      }
      await rm(path, { force: true });
    }
    throw new Error(`The run lock at ${path} could not be acquired.`);
  } finally {
    await rm(staged, { force: true });
  }
};

/** Claim the lock by linking a written candidate. `EEXIST` means another writer holds it. */
const claimRunLock = async (staged: string, path: string): Promise<boolean> => {
  try {
    await link(staged, path);
    return true;
  } catch (error) {
    if ((error as { readonly code?: string }).code !== "EEXIST") throw error;
    return false;
  }
};

/** Release only a lock that still names this process. */
const releaseRunLock = async (path: string): Promise<void> => {
  if ((await lockHolderPid(path)) !== process.pid) return;
  await rm(path, { force: true });
};

/**
 * Drop the records that the resumed prefix does not cover. A stop inside a
 * negotiation window leaves records after the last completed command, and the
 * resumed run plays that window again. The incomplete tail is removed first so
 * the log keeps one record per index and one sequence number per event.
 */
/** A resume needs a run directory that already holds a stored package. */
const assertRunDirectory = async (directory: string): Promise<void> => {
  try {
    await access(directory);
  } catch {
    throw new Error(`The run directory ${directory} does not exist.`);
  }
};

const truncateTimelineTo = async (path: string, recordCount: number): Promise<void> => {
  const text = await readFile(path, "utf8");
  const length = completeLineBytes(text, recordCount);
  if (length < text.length) await truncate(path, length);
};

const completeLineBytes = (text: string, recordCount: number): number =>
  text
    .split("\n")
    .slice(0, recordCount)
    .reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);

/** Every Pi seat must name a session file that still exists. */
const missingSeatSessions = async (
  directory: string,
  manifest: RunManifest,
): Promise<ReadonlyArray<string>> => {
  const missing: string[] = [];
  for (const seat of manifest.seats) {
    if (seat.agentType !== "pi") continue;
    if (seat.sessionFile === null) {
      missing.push(`${seat.seatId} has no recorded session file`);
      continue;
    }
    try {
      await access(resolve(directory, seat.sessionFile));
    } catch {
      missing.push(`${seat.seatId} is missing ${seat.sessionFile}`);
    }
  }
  return missing;
};

/** Absolute session files for the Pi seats that already record one. */
const seatSessionFiles = (
  directory: string,
  manifest: RunManifest,
): ReadonlyMap<string, string> => {
  const sessions = new Map<string, string>();
  for (const seat of manifest.seats) {
    if (seat.agentType !== "pi" || seat.sessionFile === null) continue;
    sessions.set(seat.seatId, resolve(directory, seat.sessionFile));
  }
  return sessions;
};

export class RunRecorder {
  readonly directory: string;
  readonly sessionsDirectory: string;
  readonly timelinePath: string;
  readonly #clock: RunClock;
  readonly #startedAtMonotonic: number;
  readonly #timeline: FileHandle;
  #manifest: RunManifest;
  #nextIndex: number;
  #lastOffsetMs: number;
  #closed = false;
  readonly #releaseLock: () => Promise<void>;

  private constructor(options: {
    readonly directory: string;
    readonly manifest: RunManifest;
    readonly timeline: FileHandle;
    readonly clock: RunClock;
    readonly startedAtMonotonic: number;
    readonly nextIndex: number;
    readonly lastOffsetMs: number;
    readonly releaseLock: () => Promise<void>;
  }) {
    this.directory = options.directory;
    this.sessionsDirectory = resolve(options.directory, "sessions");
    this.timelinePath = resolve(options.directory, options.manifest.timeline);
    this.#manifest = options.manifest;
    this.#timeline = options.timeline;
    this.#clock = options.clock;
    this.#startedAtMonotonic = options.startedAtMonotonic;
    this.#nextIndex = options.nextIndex;
    this.#lastOffsetMs = options.lastOffsetMs;
    this.#releaseLock = options.releaseLock;
  }

  static async create(options: CreateRunRecorderOptions): Promise<RunRecorder> {
    const directory = resolve(options.directory);
    await mkdir(resolve(directory, ".."), { recursive: true });
    await mkdir(directory);
    await mkdir(resolve(directory, "sessions"));
    const releaseLock = await acquireRunLock(directory);
    try {
      const clock = options.clock ?? systemClock();
      const startedAtMonotonic = clock.monotonicMs();
      const manifest: RunManifest = {
        schema: RUN_MANIFEST_SCHEMA,
        runId: options.runId,
        matchId: options.config.matchId,
        status: "partial",
        startedAt: clock.utcNow().toISOString(),
        finishedAt: null,
        timeline: "timeline.jsonl",
        timing: "monotonic",
        piVersion: options.piVersion ?? null,
        initialStateOrigin: options.initialStateOrigin,
        seats: options.seats.map((seat) => ({
          ...seat,
          sessionId: null,
          sessionFile: null,
        })),
      };
      const timeline = await open(resolve(directory, manifest.timeline), "ax");
      const recorder = new RunRecorder({
        directory,
        manifest,
        timeline,
        clock,
        startedAtMonotonic,
        nextIndex: 0,
        lastOffsetMs: 0,
        releaseLock,
      });
      await recorder.#writeManifest();
      await recorder.#append("run.started", "public", { config: options.config });
      return recorder;
    } catch (error) {
      await releaseLock();
      throw error;
    }
  }

  /**
   * Open a stopped run and continue it. The stored prefix becomes the state and
   * the recorder appends to the same timeline. The lock is taken before the
   * package is read, so the resume decision cannot come from a stale read.
   */
  static async open(options: OpenRunRecorderOptions): Promise<OpenedRun> {
    const directory = resolve(options.directory);
    const clock = options.clock ?? systemClock();
    await assertRunDirectory(directory);
    // The lock is taken before the package is read. The resume decision and the
    // records it removes must come from a timeline that no other writer can
    // change, or a stale read could truncate a run that another process finished.
    const releaseLock = await acquireRunLock(directory);
    try {
      const pkg = await readRunPackage(directory);
      const resume = assertResumable(directory, pkg);
      if (options.mode === "warm") {
        const missing = await missingSeatSessions(directory, pkg.manifest);
        if (missing.length > 0) {
          throw new Error(`A warm resume needs every seat session: ${missing.join("; ")}.`);
        }
      }
      const timelinePath = resolve(directory, pkg.manifest.timeline);
      await truncateTimelineTo(timelinePath, resume.nextIndex);
      const timeline = await open(timelinePath, "a");
      const recorder = new RunRecorder({
        directory,
        manifest: pkg.manifest,
        timeline,
        clock,
        // The baseline moves back by the stored offset, so the resumed records
        // continue the stored offsets instead of restarting at zero. A long run
        // would otherwise report every resumed record at its final offset.
        startedAtMonotonic: clock.monotonicMs() - resume.lastOffsetMs,
        nextIndex: resume.nextIndex,
        lastOffsetMs: resume.lastOffsetMs,
        releaseLock,
      });
      await recorder.#writeManifest();
      await recorder.#append("run.resumed", "public", {
        mode: options.mode,
        resumedAtIndex: resume.nextIndex,
        replayedSequence: resume.replayedSequence,
        verification: resume.verification,
        reason: safeReason(options.reason),
        priorSpendUsd: spendUsdFrom(pkg.records, resume.nextIndex),
      });
      return {
        recorder,
        resume,
        sessions:
          options.mode === "warm"
            ? seatSessionFiles(directory, pkg.manifest)
            : new Map<string, string>(),
      };
    } catch (error) {
      await releaseLock();
      throw error;
    }
  }

  /**
   * Close the recorder without writing a terminal record. The run stays partial
   * and another process can resume it.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#timeline.close();
    this.#closed = true;
    await this.#releaseLock();
  }

  get manifest(): RunManifest {
    return structuredClone(this.#manifest);
  }

  async recordActivity(activity: MatchActivity): Promise<void> {
    await this.#append(activity.kind, visibilityFor(activity), activity.payload);
  }

  async registerPiSession(
    seatId: PlayerId,
    session: { readonly sessionId: string; readonly sessionFile: string },
  ): Promise<void> {
    this.#assertOpen();
    const sessionFile = resolve(session.sessionFile);
    const relativeFile = relative(this.directory, sessionFile);
    const packageSessionFile = relativeFile.split(platformSeparator).join("/");
    const relativeSessionFile = relative(this.sessionsDirectory, sessionFile);
    if (
      relativeSessionFile.length === 0 ||
      relativeSessionFile.startsWith("..") ||
      isAbsolute(relativeSessionFile)
    ) {
      throw new Error(`The Pi session for ${seatId} is outside the run sessions directory.`);
    }
    let found = false;
    const seats = this.#manifest.seats.map((seat): RunSeatManifest => {
      if (seat.seatId !== seatId) return seat;
      found = true;
      if (seat.agentType !== "pi") throw new Error(`Seat ${seatId} is not a Pi seat.`);
      return { ...seat, sessionId: session.sessionId, sessionFile: packageSessionFile };
    });
    if (!found) throw new Error(`Run manifest has no seat ${seatId}.`);
    const manifest = { ...this.#manifest, seats };
    await this.#writeManifest(manifest);
    this.#manifest = manifest;
  }

  async complete(result: MatchRunResult): Promise<void> {
    await this.#append("run.completed", "public", terminalSummary(result));
    await this.#finish("completed");
  }

  async fail(result: MatchRunResult | null, reason: string): Promise<void> {
    const summary =
      result === null
        ? { gameSequence: -1, negotiationSequence: -1, winnerPlayerId: null }
        : terminalSummary(result);
    await this.#append("run.failed", "public", { ...summary, reason: safeReason(reason) });
    await this.#finish("failed");
  }

  async cancel(result: MatchRunResult | null, reason: string): Promise<void> {
    const summary =
      result === null
        ? { gameSequence: -1, negotiationSequence: -1, winnerPlayerId: null }
        : terminalSummary(result);
    await this.#append("run.cancelled", "public", { ...summary, reason: safeReason(reason) });
    await this.#finish("cancelled");
  }

  async #append(
    kind: RunRecord["kind"],
    visibility: RunVisibility,
    payload: unknown,
  ): Promise<void> {
    this.#assertOpen();
    const measuredOffset =
      this.#nextIndex === 0
        ? 0
        : Math.max(0, Math.round(this.#clock.monotonicMs() - this.#startedAtMonotonic));
    const offsetMs = Math.max(this.#lastOffsetMs, measuredOffset);
    const record = {
      schema: RUN_RECORD_SCHEMA,
      runId: this.#manifest.runId,
      index: this.#nextIndex,
      offsetMs,
      recordedAt: this.#clock.utcNow().toISOString(),
      kind,
      visibility,
      payload,
    };
    await this.#timeline.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
    await this.#timeline.sync();
    this.#nextIndex += 1;
    this.#lastOffsetMs = offsetMs;
  }

  async #finish(status: Exclude<RunStatus, "partial">): Promise<void> {
    const manifest: RunManifest = {
      ...this.#manifest,
      status,
      finishedAt: this.#clock.utcNow().toISOString(),
    };
    await this.#writeManifest(manifest);
    this.#manifest = manifest;
    await this.#timeline.close();
    this.#closed = true;
    await this.#releaseLock();
  }

  async #writeManifest(manifest = this.#manifest): Promise<void> {
    const path = resolve(this.directory, "manifest.json");
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The run recorder is closed.");
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const RUN_KINDS = new Set<RunRecord["kind"]>([
  "run.started",
  "game.event",
  "game.command-completed",
  "negotiation.event",
  "game.agent-requested",
  "game.decision",
  "negotiation.agent-requested",
  "negotiation.decision",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.resumed",
]);

const isRunStatus = (value: unknown): value is RunStatus =>
  value === "partial" || value === "completed" || value === "failed" || value === "cancelled";

const hasManifestIdentity = (value: Readonly<Record<string, unknown>>): boolean =>
  value["schema"] === RUN_MANIFEST_SCHEMA &&
  typeof value["runId"] === "string" &&
  typeof value["matchId"] === "string";

const isDateTime = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

const hasManifestLifecycle = (value: Readonly<Record<string, unknown>>): boolean => {
  if (!isRunStatus(value["status"]) || !isDateTime(value["startedAt"])) return false;
  const finishedAt = value["finishedAt"];
  if (value["status"] === "partial") return finishedAt === null;
  return isDateTime(finishedAt) && Date.parse(finishedAt) >= Date.parse(value["startedAt"]);
};

const isModelIdentity = (value: unknown): boolean =>
  isRecord(value) && typeof value["provider"] === "string" && typeof value["modelId"] === "string";

const hasSeatIdentity = (value: Readonly<Record<string, unknown>>): boolean =>
  typeof value["seatId"] === "string" &&
  (value["agentType"] === "pi" || value["agentType"] === "scripted") &&
  (value["model"] === null || isModelIdentity(value["model"]));

const hasSeatSession = (value: Readonly<Record<string, unknown>>): boolean =>
  (value["sessionId"] === null || typeof value["sessionId"] === "string") &&
  (value["sessionFile"] === null || typeof value["sessionFile"] === "string");

const isSeatManifest = (value: unknown): value is RunSeatManifest =>
  isRecord(value) && hasSeatIdentity(value) && hasSeatSession(value);

const hasSafeSessionPath = (seat: RunSeatManifest): boolean => {
  if (seat.sessionFile === null) return seat.sessionId === null;
  const path = seat.sessionFile;
  return (
    seat.sessionId !== null &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/u).includes("..") &&
    path.startsWith("sessions/")
  );
};

const isObservedOrigin = (value: Readonly<Record<string, unknown>>): boolean =>
  value["type"] === "observed" &&
  typeof value["adapterId"] === "string" &&
  value["adapterId"].length > 0;

const isGeneratedOrigin = (value: Readonly<Record<string, unknown>>): boolean =>
  value["type"] === "generated" &&
  typeof value["generatorId"] === "string" &&
  value["generatorId"].length > 0 &&
  Number.isSafeInteger(value["seed"]) &&
  Number(value["seed"]) >= 0 &&
  Number(value["seed"]) <= 0xffff_ffff;

const isInitialStateOrigin = (value: unknown): value is InitialStateOrigin =>
  isRecord(value) && (isObservedOrigin(value) || isGeneratedOrigin(value));

const hasManifestFiles = (value: Readonly<Record<string, unknown>>): boolean => {
  const seats = value["seats"];
  if (
    value["timeline"] !== "timeline.jsonl" ||
    value["timing"] !== "monotonic" ||
    (typeof value["piVersion"] !== "string" && value["piVersion"] !== null) ||
    !isInitialStateOrigin(value["initialStateOrigin"]) ||
    !Array.isArray(seats) ||
    !seats.every((seat) => isSeatManifest(seat) && hasSafeSessionPath(seat))
  ) {
    return false;
  }
  const validSeats = seats as ReadonlyArray<RunSeatManifest>;
  return new Set(validSeats.map((seat) => seat.seatId)).size === validSeats.length;
};

const parseManifest = (value: unknown): RunManifest => {
  if (
    !isRecord(value) ||
    !hasManifestIdentity(value) ||
    !hasManifestLifecycle(value) ||
    !hasManifestFiles(value)
  ) {
    throw new Error("The run manifest is invalid.");
  }
  return value as unknown as RunManifest;
};

const hasRecordIdentity = (value: Readonly<Record<string, unknown>>): boolean =>
  value["schema"] === RUN_RECORD_SCHEMA && typeof value["runId"] === "string";

const hasRecordPosition = (value: Readonly<Record<string, unknown>>): boolean =>
  Number.isSafeInteger(value["index"]) &&
  Number(value["index"]) >= 0 &&
  Number.isSafeInteger(value["offsetMs"]) &&
  Number(value["offsetMs"]) >= 0 &&
  typeof value["recordedAt"] === "string" &&
  !Number.isNaN(Date.parse(value["recordedAt"]));

const isVisibility = (value: unknown): value is RunVisibility =>
  value === "public" ||
  value === "referee" ||
  (isRecord(value) && value["type"] === "seat" && typeof value["seatId"] === "string");

const hasRecordPayload = (value: Readonly<Record<string, unknown>>): boolean =>
  typeof value["kind"] === "string" &&
  RUN_KINDS.has(value["kind"] as RunRecord["kind"]) &&
  isVisibility(value["visibility"]) &&
  "payload" in value;

export const parseRunRecord = (value: unknown): RunRecord => {
  if (
    !isRecord(value) ||
    !hasRecordIdentity(value) ||
    !hasRecordPosition(value) ||
    !hasRecordPayload(value)
  ) {
    throw new Error("The run record is invalid.");
  }
  return value as unknown as RunRecord;
};

const parseCompleteLines = (text: string): ReadonlyArray<RunRecord> => {
  const completeText = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  return completeText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseRunRecord(JSON.parse(line)));
};

const validateTimelineOrder = (manifest: RunManifest, records: ReadonlyArray<RunRecord>): void => {
  let previousOffset = -1;
  for (const [index, record] of records.entries()) {
    if (
      record.runId !== manifest.runId ||
      record.index !== index ||
      record.offsetMs < previousOffset
    ) {
      throw new Error("The run timeline order is invalid.");
    }
    previousOffset = record.offsetMs;
  }
};

const validateTerminalRecord = (manifest: RunManifest, records: ReadonlyArray<RunRecord>): void => {
  if (records[0]?.kind !== "run.started") {
    throw new Error("The run timeline has no start record.");
  }
  if (manifest.status === "partial") return;
  if (records.at(-1)?.kind !== `run.${manifest.status}`) {
    throw new Error("The run manifest and terminal record do not agree.");
  }
};

const decodeStartedConfig = async (
  manifest: RunManifest,
  record: RunRecord | undefined,
): Promise<GameConfig> => {
  if (record?.kind !== "run.started" || !isRecord(record.payload)) {
    throw new Error("The run start record is invalid.");
  }
  const config = await Effect.runPromise(
    decodeGameConfig(record.payload["config"]).pipe(
      Effect.mapError(() => new Error("The run start configuration is invalid.")),
    ),
  );
  if (config.matchId !== manifest.matchId) {
    throw new Error("The run start configuration does not match the manifest.");
  }
  if (
    manifest.initialStateOrigin.type === "generated" &&
    manifest.initialStateOrigin.seed !== config.seed
  ) {
    throw new Error("The generated run origin seed does not match the start configuration.");
  }
  return config;
};

const decodeRecordedGameEvent = async (payload: unknown): Promise<GameEvent> =>
  (await Effect.runPromise(
    decodeGameEventEnvelope(payload).pipe(
      Effect.mapError(() => new Error("The run timeline contains a malformed game event.")),
    ),
  )) as GameEvent;

const decodeRecordedNegotiationEvent = async (payload: unknown): Promise<NegotiationEvent> =>
  (await Effect.runPromise(
    decodeNegotiationEvent(payload).pipe(
      Effect.mapError(() => new Error("The run timeline contains a malformed negotiation event.")),
    ),
  )) as NegotiationEvent;

const assertEventIdentity = (
  event: { readonly matchId: string; readonly sequence: number },
  manifest: RunManifest,
  label: string,
): void => {
  if (
    event.matchId !== manifest.matchId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 0
  ) {
    throw new Error(`The run timeline contains an invalid ${label} identity.`);
  }
};

const assertCommandMarker = (
  record: RunRecord,
  batch: ReadonlyArray<GameEvent>,
  manifest: RunManifest,
): void => {
  const last = batch.at(-1);
  if (record.kind !== "game.command-completed" || !isRecord(record.payload) || last === undefined) {
    throw new Error("The run timeline contains an invalid command marker.");
  }
  const oneCommand = batch.every(
    (event) => event.commandId === last.commandId && event.matchId === manifest.matchId,
  );
  if (
    !oneCommand ||
    record.payload["matchId"] !== manifest.matchId ||
    record.payload["commandId"] !== last.commandId ||
    record.payload["sequence"] !== last.sequence
  ) {
    throw new Error("The run timeline contains an invalid atomic command batch.");
  }
};

interface GameTimelineValidation {
  readonly events: GameEvent[];
  readonly rawEvents: unknown[];
  readonly negotiations: NegotiationEvent[];
  completedEventCount: number;
  negotiationSequence: number;
  /** Records that end at the last completed command. */
  completedRecordCount: number;
  /** Negotiation events that belong to the last completed command prefix. */
  completedNegotiationCount: number;
  /** True when a negotiation window is open at the last completed command. */
  completedInsideWindow: boolean;
  openWindows: number;
}

const countWindowEvent = (validation: GameTimelineValidation, event: NegotiationEvent): void => {
  if (event.event.type === "negotiation.window-opened") validation.openWindows += 1;
  if (event.event.type === "negotiation.window-closed") validation.openWindows -= 1;
};

const consumeNegotiationRecord = async (
  validation: GameTimelineValidation,
  manifest: RunManifest,
  payload: unknown,
): Promise<void> => {
  const event = await decodeRecordedNegotiationEvent(payload);
  assertEventIdentity(event, manifest, "negotiation event");
  if (
    !Number.isSafeInteger(event.gameSequence) ||
    event.gameSequence < 0 ||
    event.sequence !== validation.negotiationSequence + 1
  ) {
    throw new Error("The run timeline negotiation event sequence is invalid.");
  }
  validation.negotiationSequence = event.sequence;
  validation.negotiations.push(event);
  countWindowEvent(validation, event);
};

const consumeGameRecord = async (
  validation: GameTimelineValidation,
  manifest: RunManifest,
  record: RunRecord,
): Promise<void> => {
  if (record.kind === "game.event") {
    const event = await decodeRecordedGameEvent(record.payload);
    assertEventIdentity(event, manifest, "game event");
    validation.events.push(event);
    validation.rawEvents.push(record.payload);
    return;
  }
  if (record.kind === "negotiation.event") {
    await consumeNegotiationRecord(validation, manifest, record.payload);
    return;
  }
  if (record.kind !== "game.command-completed") return;
  assertCommandMarker(record, validation.events.slice(validation.completedEventCount), manifest);
  validation.completedEventCount = validation.events.length;
  validation.completedRecordCount = record.index + 1;
  validation.completedNegotiationCount = validation.negotiations.length;
  validation.completedInsideWindow = validation.openWindows > 0;
};

const initialRecordedState = (
  validation: GameTimelineValidation,
  config: GameConfig,
): GameState | null => {
  const first = validation.events[0];
  if (first === undefined) return null;
  if (first.event.type !== "game.created" || !isDeepStrictEqual(first.event.state.config, config)) {
    throw new Error("The first game event does not match the run start configuration.");
  }
  return first.event.state;
};

const assertCompleteCommandTail = (
  manifest: RunManifest,
  validation: GameTimelineValidation,
): void => {
  if (
    manifest.status === "completed" &&
    validation.completedEventCount !== validation.events.length
  ) {
    throw new Error("The run timeline ends inside an atomic command batch.");
  }
};

interface EventTimelineResult {
  readonly config: GameConfig;
  readonly state: GameState | null;
  readonly replayedState: GameState | null;
  readonly events: ReadonlyArray<GameEvent>;
  readonly eventPayloads: ReadonlyArray<unknown>;
  readonly negotiations: ReadonlyArray<NegotiationEvent>;
  readonly replayedSequence: number;
  /** Record index that the resume continues from. */
  readonly boundaryIndex: number;
  /** True when a negotiation window is open at that boundary. */
  readonly boundaryInsideWindow: boolean;
}

const validateEventTimeline = async (
  manifest: RunManifest,
  records: ReadonlyArray<RunRecord>,
): Promise<EventTimelineResult> => {
  const config = await decodeStartedConfig(manifest, records[0]);
  const validation: GameTimelineValidation = {
    events: [],
    rawEvents: [],
    negotiations: [],
    completedEventCount: 0,
    negotiationSequence: -1,
    completedRecordCount: 0,
    completedNegotiationCount: 0,
    completedInsideWindow: false,
    openWindows: 0,
  };
  for (const record of records) await consumeGameRecord(validation, manifest, record);
  const initialState = initialRecordedState(validation, config);
  assertCompleteCommandTail(manifest, validation);
  const boundary = {
    boundaryIndex: validation.completedRecordCount,
    boundaryInsideWindow: validation.completedInsideWindow,
  };
  if (validation.completedEventCount === 0 || initialState === null) {
    return {
      config,
      state: null,
      replayedState: null,
      events: [],
      eventPayloads: [],
      negotiations: [],
      replayedSequence: -1,
      ...boundary,
    };
  }
  const completeEvents = validation.rawEvents.slice(0, validation.completedEventCount);
  const replayedState = await Effect.runPromise(
    replay(completeEvents).pipe(
      Effect.mapError(() => new Error("The run timeline game events cannot replay.")),
    ),
  );
  if (manifest.initialStateOrigin.type === "generated") {
    await Effect.runPromise(
      verifyNativeReplay(completeEvents).pipe(
        Effect.mapError(() => new Error("The run timeline does not match native execution.")),
      ),
    );
  }
  return {
    config,
    state: initialState,
    replayedState,
    events: validation.events.slice(0, validation.completedEventCount),
    eventPayloads: completeEvents,
    // The window that a stop cut in half is not part of the prefix, because the
    // resumed run plays that window again.
    negotiations: validation.negotiations.slice(0, validation.completedNegotiationCount),
    replayedSequence: replayedState.sequence,
    ...boundary,
  };
};

const verificationFor = async (
  manifest: RunManifest,
  state: GameState | null,
): Promise<RunVerification> => {
  if (state === null) {
    return { generatorMatch: "pending", commandVerification: "pending" };
  }
  if (manifest.initialStateOrigin.type === "observed") {
    return { generatorMatch: "not-applicable", commandVerification: "not-applicable" };
  }
  const matches = await Effect.runPromise(matchesCurrentGenerator(state));
  return {
    generatorMatch: matches ? "matches-current" : "differs-from-current",
    commandVerification: "exact",
  };
};

/**
 * One harness loop iteration writes one decision record. A failed first attempt
 * writes a failed record and then a fallback record, so the records that are not
 * failures count the decisions the run has already made.
 */
/**
 * A stop inside a negotiation window leaves records after the last completed
 * command. A window cannot continue from its middle, so the run refuses to
 * resume from its own timeline instead of silently dropping the round.
 */
const OPEN_WINDOW_RESUME_BLOCKED =
  "The stored timeline ends inside an open negotiation window, so the run cannot resume from its own timeline.";

interface ResumeAvailability {
  readonly resume: RunResume | null;
  readonly blockedReason: string | null;
}

const completedDecisions = (records: ReadonlyArray<RunRecord>, boundaryIndex: number): number =>
  records.filter(
    (record) =>
      record.index < boundaryIndex &&
      record.kind === "game.decision" &&
      isRecord(record.payload) &&
      record.payload["outcome"] !== "failed",
  ).length;

const carriedSpendUsd = (record: RunRecord): number => {
  if (record.kind !== "run.resumed") return 0;
  const prior = record.payload.priorSpendUsd;
  return typeof prior === "number" && Number.isFinite(prior) ? prior : 0;
};

const decisionCostUsd = (record: RunRecord): number | null => {
  if (record.kind !== "game.decision" && record.kind !== "negotiation.decision") return null;
  const payload = record.payload;
  if (!isRecord(payload)) return null;
  const usage = payload["usage"];
  if (!isRecord(usage)) return null;
  const cost = usage["cost"];
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
};

/** The money one record brings to the whole-run ceiling from index `fromIndex` on. */
const recordSpendUsd = (record: RunRecord, fromIndex: number): number => {
  if (record.index < fromIndex) return 0;
  if (record.kind === "run.resumed") return carriedSpendUsd(record);
  return decisionCostUsd(record) ?? 0;
};

/** Spend the timeline holds at or after `fromIndex` for the whole run. */
const spendUsdFrom = (records: ReadonlyArray<RunRecord>, fromIndex: number): number =>
  records.reduce((total, record) => total + recordSpendUsd(record, fromIndex), 0);

const resumeAvailability = (
  manifest: RunManifest,
  records: ReadonlyArray<RunRecord>,
  timeline: EventTimelineResult,
  verification: RunVerification,
): ResumeAvailability => {
  if (manifest.status !== "partial" || timeline.replayedState === null) {
    return { resume: null, blockedReason: null };
  }
  if (timeline.boundaryInsideWindow) {
    return { resume: null, blockedReason: OPEN_WINDOW_RESUME_BLOCKED };
  }
  return {
    blockedReason: null,
    resume: {
      config: timeline.config,
      state: timeline.replayedState,
      events: timeline.events,
      eventPayloads: timeline.eventPayloads,
      negotiations: timeline.negotiations,
      decisionCount: completedDecisions(records, timeline.boundaryIndex),
      observedSpendUsd: spendUsdFrom(records, 0),
      nextIndex: timeline.boundaryIndex,
      lastOffsetMs: records[timeline.boundaryIndex - 1]?.offsetMs ?? 0,
      replayedSequence: timeline.replayedSequence,
      verification: verification.commandVerification,
    },
  };
};

export const readRunPackage = async (directory: string): Promise<RunPackage> => {
  const root = resolve(directory);
  const [manifestText, timelineText] = await Promise.all([
    readFile(resolve(root, "manifest.json"), "utf8"),
    readFile(resolve(root, "timeline.jsonl"), "utf8"),
  ]);
  const manifest = parseManifest(JSON.parse(manifestText));
  const records = parseCompleteLines(timelineText);
  validateTimelineOrder(manifest, records);
  validateTerminalRecord(manifest, records);
  const timeline = await validateEventTimeline(manifest, records);
  const verification = await verificationFor(manifest, timeline.state);
  const availability = resumeAvailability(manifest, records, timeline, verification);
  return {
    manifest,
    records,
    verification,
    resume: availability.resume,
    resumeBlockedReason: availability.blockedReason,
  };
};
