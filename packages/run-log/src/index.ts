import { mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
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

export type RunRecord =
  | RunStartedRecord
  | ActivityRunRecord
  | RunCompletedRecord
  | RunFailedRecord
  | RunCancelledRecord;

export interface RunTerminalSummary {
  readonly gameSequence: number;
  readonly negotiationSequence: number;
  readonly winnerPlayerId: PlayerId | null;
}

export interface RunPackage {
  readonly manifest: RunManifest;
  readonly records: ReadonlyArray<RunRecord>;
  readonly verification: RunVerification;
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

export class RunRecorder {
  readonly directory: string;
  readonly sessionsDirectory: string;
  readonly timelinePath: string;
  readonly #clock: RunClock;
  readonly #startedAtMonotonic: number;
  readonly #timeline: FileHandle;
  #manifest: RunManifest;
  #nextIndex = 0;
  #lastOffsetMs = 0;
  #closed = false;

  private constructor(
    directory: string,
    manifest: RunManifest,
    timeline: FileHandle,
    clock: RunClock,
    startedAtMonotonic: number,
  ) {
    this.directory = directory;
    this.sessionsDirectory = resolve(directory, "sessions");
    this.timelinePath = resolve(directory, manifest.timeline);
    this.#manifest = manifest;
    this.#timeline = timeline;
    this.#clock = clock;
    this.#startedAtMonotonic = startedAtMonotonic;
  }

  static async create(options: CreateRunRecorderOptions): Promise<RunRecorder> {
    const directory = resolve(options.directory);
    await mkdir(resolve(directory, ".."), { recursive: true });
    await mkdir(directory);
    await mkdir(resolve(directory, "sessions"));
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
    const recorder = new RunRecorder(directory, manifest, timeline, clock, startedAtMonotonic);
    await recorder.#writeManifest();
    await recorder.#append("run.started", "public", { config: options.config });
    return recorder;
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
  completedEventCount: number;
  negotiationSequence: number;
}

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
    const event = await decodeRecordedNegotiationEvent(record.payload);
    assertEventIdentity(event, manifest, "negotiation event");
    if (
      !Number.isSafeInteger(event.gameSequence) ||
      event.gameSequence < 0 ||
      event.sequence !== validation.negotiationSequence + 1
    ) {
      throw new Error("The run timeline negotiation event sequence is invalid.");
    }
    validation.negotiationSequence = event.sequence;
    return;
  }
  if (record.kind !== "game.command-completed") return;
  assertCommandMarker(record, validation.events.slice(validation.completedEventCount), manifest);
  validation.completedEventCount = validation.events.length;
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
    manifest.status !== "partial" &&
    validation.completedEventCount !== validation.events.length
  ) {
    throw new Error("The run timeline ends inside an atomic command batch.");
  }
};

const validateEventTimeline = async (
  manifest: RunManifest,
  records: ReadonlyArray<RunRecord>,
): Promise<GameState | null> => {
  const config = await decodeStartedConfig(manifest, records[0]);
  const validation: GameTimelineValidation = {
    events: [],
    rawEvents: [],
    completedEventCount: 0,
    negotiationSequence: -1,
  };
  for (const record of records) await consumeGameRecord(validation, manifest, record);
  const initialState = initialRecordedState(validation, config);
  assertCompleteCommandTail(manifest, validation);
  if (validation.completedEventCount === 0 || initialState === null) return null;
  const completeEvents = validation.rawEvents.slice(0, validation.completedEventCount);
  await Effect.runPromise(
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
  return initialState;
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
  const state = await validateEventTimeline(manifest, records);
  return { manifest, records, verification: await verificationFor(manifest, state) };
};
