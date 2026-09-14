#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { STANDARD_BOARD_GENERATOR_ID } from "@catanarchy/engine";
import {
  runGameSteps,
  type AgentUsage,
  type MatchActivity,
  type MatchRunResult,
  type NegotiationPolicy,
} from "@catanarchy/harness";
import {
  applyEnvironmentAuthentication,
  applyThinkingLevels,
  assertModelsAvailable,
  createPiAgentFactory,
  loadThinkingLevelsConfig,
  ModelRuntime,
  parseModelReference,
  PI_THINKING_LEVELS,
  PiCostBudget,
  pinOpenRouterProvider,
  resolveThinkingLevels,
  withPiCostBudget,
  type PiAgentFactoryOptions,
  type PiModelReference,
  type ThinkingLevelsApplication,
} from "@catanarchy/pi-agent";
import type { GameConfig } from "@catanarchy/protocol";
import {
  readRunPackage,
  RunRecorder,
  type OpenedRun,
  type RunLaunchConfiguration,
  type RunManifest,
  type RunResume,
  type RunResumeMode,
} from "@catanarchy/run-log";
import { Effect } from "effect";

const argument = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

const subcommand = process.argv[2] === "resume" ? "resume" : "run";

const integerArgument = (
  name: string,
  defaultValue: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const value = Number(argument(name) ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
};

const optionalIntegerArgument = (
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined => {
  const rawValue = argument(name);
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
};

const numberArgument = (name: string, defaultValue: number): number => {
  const value = Number(argument(name) ?? defaultValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number.`);
  }
  return value;
};

const thinkingArgument = (): NonNullable<PiAgentFactoryOptions["thinkingLevel"]> => {
  const value = argument("thinking") ?? "high";
  const levels = new Set<string>(PI_THINKING_LEVELS);
  if (!levels.has(value)) throw new Error("--thinking is not a supported thinking level.");
  return value as NonNullable<PiAgentFactoryOptions["thinkingLevel"]>;
};

const seed = integerArgument("seed", 42, 0, 0xffff_ffff);
const turnTimeMs = integerArgument("turn-time-ms", 600_000, 1, 0x7fff_ffff);
/** The finalization grace of one decision. A live run needs minutes, not seconds. */
const finalizationGraceMs = integerArgument("finalization-grace-ms", 300_000, 1, 0x7fff_ffff);
const maxPlanningSteps = integerArgument("max-planning-steps", 8, 1, 1_000);
const maxAttempts = integerArgument("max-attempts", 1, 1);
const maxOutputTokens = optionalIntegerArgument("max-output-tokens", 1);
const pauseAfterDecisions = optionalIntegerArgument("pause-after-decisions", 1);
const pauseAfterDecisionsReport = pauseAfterDecisions ?? null;
const resumeSignal = argument("resume-signal");
if ((pauseAfterDecisions === undefined) !== (resumeSignal === undefined)) {
  throw new Error("--pause-after-decisions and --resume-signal must be used together.");
}
const resumeSignalPath = resumeSignal === undefined ? null : resolve(resumeSignal);
const contextWindowTokens = integerArgument("context-window-tokens", 131_072, 32_768);
const costCeilingUsd = numberArgument("cost-ceiling-usd", 5);
const thinkingLevel = thinkingArgument();
const maxDecisions = integerArgument("decisions", 16, 1);
const negotiationRounds = integerArgument("negotiation-rounds", 1, 0, 10);
const maxMessageLength = integerArgument("max-message-length", 500, 1, 10_000);
const maxOpenOffers = integerArgument("max-open-offers", 8, 1, 100);
const negotiationPolicy =
  negotiationRounds === 0
    ? undefined
    : { maxRounds: negotiationRounds, maxMessageLength, maxOpenOffers };
const outputPath = argument("output");
const modelsPath = argument("models-path");
const modelsPathReport = modelsPath === undefined ? null : resolve(modelsPath);
const openRouterProvider = argument("openrouter-provider");
const openRouterProviderReport = openRouterProvider ?? null;
/** The version-controlled thinking-levels config of the run, or null when the run uses none. */
const thinkingLevelsPath = argument("thinking-levels");
const thinkingLevelsPathReport =
  thinkingLevelsPath === undefined ? null : resolve(thinkingLevelsPath);
const modelReferences = (
  argument("models") ?? "openai/gpt-5.6-luna,huggingface/deepseek-ai/DeepSeek-V4-Flash"
)
  .split(",")
  .filter((value) => value.length > 0)
  .map(parseModelReference);

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: `pi-game-${seed}`,
  seed,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
    { id: "orange", name: "Orange", color: "orange" },
  ],
};

const runStartedAt = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const runId = argument("run-id") ?? `${config.matchId}-${runStartedAt}`;
const runDirectory = resolve(argument("run-dir") ?? `runs/${runId}`);
const piVersion = "0.85.1";

const outerDecisionTimeoutMs = turnTimeMs + finalizationGraceMs + 60_000;
if (!Number.isSafeInteger(outerDecisionTimeoutMs) || outerDecisionTimeoutMs > 0x7fff_ffff) {
  throw new Error("The turn time, finalization grace, and outer safety margin are too large.");
}

/**
 * The settings this invocation runs with, except the resolved thinking levels, which need the
 * model runtime. The run record carries them, so a package states its own thinking level, time
 * pools, and limits.
 */
const launchConfiguration: Omit<RunLaunchConfiguration, "thinkingLevels"> = {
  thinkingLevel,
  thinkingLevelsPath: thinkingLevelsPathReport,
  turnTimeMs,
  finalizationGraceMs,
  decisionTimeoutMs: outerDecisionTimeoutMs,
  contextWindowTokens,
  maxPlanningSteps,
  maxAttempts,
  maxDecisions,
  maxOutputTokens: maxOutputTokens ?? null,
  maxMessageLength: negotiationPolicy === undefined ? null : maxMessageLength,
  maxOpenOffers: negotiationPolicy === undefined ? null : maxOpenOffers,
  costCeilingUsd,
};

interface RunBounds {
  readonly maximumRequests: number;
  readonly maximumModelMessagesPerRequest: number;
  readonly maximumProviderCalls: number;
}

const runBounds = (playerCount: number, decisions: number): RunBounds => {
  const setupDecisionCount = playerCount * 4;
  const maximumNegotiationWindows = Math.max(0, Math.floor((decisions - setupDecisionCount) / 2));
  const maximumRequests =
    decisions * maxAttempts +
    maximumNegotiationWindows * playerCount * negotiationRounds * maxAttempts;
  const maximumModelMessagesPerRequest = maxPlanningSteps + 2;
  // Each model message can make the original call, two overflow-compaction calls, one recovery retry,
  // and two post-recovery compaction calls.
  return {
    maximumRequests,
    maximumModelMessagesPerRequest,
    maximumProviderCalls: maximumRequests * maximumModelMessagesPerRequest * 6,
  };
};

interface Estimate {
  readonly lowUsd: number;
  readonly highUsd: number;
  readonly nextRequestHighUsd: number;
}

interface PricingRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

const highestRate = (rates: ReadonlyArray<PricingRates>, field: keyof PricingRates): number =>
  Math.max(...rates.map((rate) => rate[field]));

const modelCost = (
  runtime: ModelRuntime,
  reference: PiModelReference,
  inputTokens: number,
  outputTokens: number,
  conservative: boolean,
): number => {
  const model = runtime.getModel(reference.provider, reference.modelId);
  if (model === undefined) {
    throw new Error(`Unknown Pi model: ${reference.provider}/${reference.modelId}`);
  }
  if (!conservative) {
    return (inputTokens * model.cost.input + outputTokens * model.cost.output) / 1_000_000;
  }
  const rates: ReadonlyArray<PricingRates> = [model.cost, ...(model.cost.tiers ?? [])];
  const inputCost =
    inputTokens *
    (highestRate(rates, "input") +
      highestRate(rates, "cacheRead") +
      highestRate(rates, "cacheWrite"));
  return (inputCost + outputTokens * highestRate(rates, "output")) / 1_000_000;
};

const estimateCost = (
  runtime: ModelRuntime,
  references: ReadonlyArray<PiModelReference>,
  bounds: RunBounds,
): Estimate => {
  if (references.length === 0) throw new Error("At least one model reference is required.");
  const lowPerRequest = Math.min(
    ...references.map((reference) => modelCost(runtime, reference, 8_000, 100, false)),
  );
  const highPerRequest = Math.max(
    ...references.map((reference) => {
      const model = runtime.getModel(reference.provider, reference.modelId);
      if (model === undefined) throw new Error("The model disappeared during cost estimation.");
      const contextWindow = Math.min(model.contextWindow, contextWindowTokens);
      const effectiveMaxOutputTokens = Math.min(
        model.maxTokens,
        maxOutputTokens ?? contextWindow - 1,
      );
      return modelCost(runtime, reference, contextWindow, effectiveMaxOutputTokens, true);
    }),
  );
  return {
    lowUsd: bounds.maximumRequests * lowPerRequest,
    highUsd: bounds.maximumProviderCalls * highPerRequest,
    nextRequestHighUsd: bounds.maximumModelMessagesPerRequest * 6 * highPerRequest,
  };
};

const EMPTY_USAGE: AgentUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
};

const traceUsage = (trace: { readonly usage?: AgentUsage }): AgentUsage =>
  trace.usage ?? EMPTY_USAGE;

const totalUsage = (result: MatchRunResult): AgentUsage =>
  [...result.decisions, ...result.negotiationDecisions].reduce<AgentUsage>((usage, decision) => {
    const current = traceUsage(decision);
    return {
      input: usage.input + current.input,
      output: usage.output + current.output,
      cacheRead: usage.cacheRead + current.cacheRead,
      cacheWrite: usage.cacheWrite + current.cacheWrite,
      total: usage.total + current.total,
      cost: usage.cost + current.cost,
    };
  }, EMPTY_USAGE);

/**
 * The facts a summary reports about the run itself. A resume must report the run
 * that it continued, not the flags of the current invocation.
 */
interface RunFacts {
  readonly seed: number;
  readonly models: ReadonlyArray<PiModelReference>;
  readonly resumed: boolean;
  /** Decisions the stored prefix already committed. Zero for a fresh run. */
  readonly priorDecisions: number;
  /** Spend the stored prefix already recorded. Zero for a fresh run. */
  readonly priorSpendUsd: number;
}

const summarize = (result: MatchRunResult, facts: RunFacts) => ({
  matchId: result.state.matchId,
  modelsPath: modelsPathReport,
  openRouterProvider: openRouterProviderReport,
  seed: facts.seed,
  resumed: facts.resumed,
  priorDecisions: facts.priorDecisions,
  priorSpendUsd: facts.priorSpendUsd,
  sequence: result.state.sequence,
  phase: result.state.phase,
  buildings: result.state.occupancy.buildings.length,
  roads: result.state.occupancy.roads.length,
  decisions: result.decisions.filter(({ outcome }) => outcome !== "failed").length,
  failures: result.decisions.filter(({ outcome }) => outcome === "failed").length,
  fallbacks: result.decisions.filter(({ outcome }) => outcome === "fallback").length,
  negotiationDecisions: result.negotiationDecisions.filter(({ outcome }) => outcome !== "failed")
    .length,
  negotiationFailures: result.negotiationDecisions.filter(({ outcome }) => outcome === "failed")
    .length,
  negotiationFallbacks: result.negotiationDecisions.filter(({ outcome }) => outcome === "fallback")
    .length,
  negotiationEvents: result.negotiations.length,
  usage: totalUsage(result),
  models: facts.models,
});

const createModelRuntime = async (): Promise<ModelRuntime> => {
  if (modelsPath === undefined) return ModelRuntime.create();
  const cacheDirectory = resolve(homedir(), ".cache", "catanarchy");
  await mkdir(cacheDirectory, { recursive: true });
  return ModelRuntime.create({
    modelsPath: resolve(modelsPath),
    modelsStorePath: resolve(cacheDirectory, "models-store.json"),
  });
};

/**
 * Load the thinking-levels config and apply it to the runtime. A run that names no config keeps
 * the loaded catalog. The returned list states what the config changed, and the run record
 * carries it, so a package states the level map that produced it.
 */
const configureThinkingLevels = async (
  runtime: ModelRuntime,
): Promise<ReadonlyArray<ThinkingLevelsApplication>> => {
  if (thinkingLevelsPathReport === null) return [];
  const config = await loadThinkingLevelsConfig(thinkingLevelsPathReport);
  const applications = applyThinkingLevels(runtime, config);
  console.error(
    JSON.stringify({
      event: "thinking-levels-config",
      path: thinkingLevelsPathReport,
      probedAt: config.probedAt,
      applications,
    }),
  );
  return applications;
};

const waitForResumeSignal = async (): Promise<void> => {
  if (resumeSignalPath === null) return;
  for (;;) {
    try {
      await access(resumeSignalPath);
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
};

const activityRecorder = (recorder: RunRecorder): ((activity: MatchActivity) => Promise<void>) => {
  let completedDecisions = 0;
  let initialCommandCompleted = false;
  return async (activity) => {
    await recorder.recordActivity(activity);
    if (activity.kind !== "game.command-completed") return;
    if (!initialCommandCompleted) {
      initialCommandCompleted = true;
      return;
    }
    completedDecisions += 1;
    if (completedDecisions !== pauseAfterDecisions) return;
    console.error(JSON.stringify({ event: "run-paused", completedDecisions, resumeSignalPath }));
    await waitForResumeSignal();
    console.error(JSON.stringify({ event: "run-resumed", completedDecisions }));
  };
};

const configureProviderRouting = (
  runtime: ModelRuntime,
  references: ReadonlyArray<PiModelReference>,
): void => {
  if (openRouterProvider !== undefined) {
    pinOpenRouterProvider(runtime, references, openRouterProvider);
  }
};

const budgetReport = (
  bounds: RunBounds,
  estimate: Estimate,
  observedUsd: number,
  references: ReadonlyArray<PiModelReference>,
): Record<string, unknown> => ({
  lowUsd: Number(estimate.lowUsd.toFixed(6)),
  highUsd: Number(estimate.highUsd.toFixed(6)),
  nextRequestHighUsd: Number(estimate.nextRequestHighUsd.toFixed(6)),
  observedUsd: Number(observedUsd.toFixed(6)),
  remainingUsd: Number((costCeilingUsd - observedUsd).toFixed(6)),
  ceilingUsd: costCeilingUsd,
  maximumRequests: bounds.maximumRequests,
  maximumModelMessagesPerRequest: bounds.maximumModelMessagesPerRequest,
  maximumProviderCalls: bounds.maximumProviderCalls,
  maxOutputTokens: maxOutputTokens ?? null,
  contextWindowTokens,
  thinkingLevel,
  turnTimeMs,
  finalizationGraceMs,
  maxPlanningSteps,
  negotiationRounds,
  models: references,
  modelsPath: modelsPathReport,
  openRouterProvider: openRouterProviderReport,
  pauseAfterDecisions: pauseAfterDecisionsReport,
  resumeSignalPath,
  note: "The providers do not expose an immutable per-run billing cap. The fixed request and token limits bound this smoke test.",
});

const createBudget = (estimate: Estimate, observedUsd: number): PiCostBudget => {
  if (observedUsd + estimate.nextRequestHighUsd > costCeilingUsd) {
    throw new Error(
      `The observed spend of $${observedUsd.toFixed(4)} plus the next request of $${estimate.nextRequestHighUsd.toFixed(4)} exceeds the $${costCeilingUsd.toFixed(2)} cost ceiling.`,
    );
  }
  return new PiCostBudget(costCeilingUsd, estimate.nextRequestHighUsd, observedUsd);
};

const createAgentsFor = (
  references: ReadonlyArray<PiModelReference>,
  runtime: ModelRuntime,
  recorder: RunRecorder,
  budget: PiCostBudget,
  resumedSessions: ReadonlyMap<string, string> | undefined,
) =>
  withPiCostBudget(
    createPiAgentFactory({
      models: references,
      modelRuntime: runtime,
      thinkingLevel,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      contextWindowTokens,
      turnTimeMs,
      finalizationGraceMs,
      maxPlanningSteps,
      sessionDirectory: recorder.sessionsDirectory,
      ...(resumedSessions === undefined ? {} : { resumedSessions }),
      onSessionCreated: async (player, session) => recorder.registerPiSession(player.id, session),
    }),
    budget,
  );

const reportResult = async (
  result: MatchRunResult,
  recorder: RunRecorder,
  budget: PiCostBudget,
  facts: RunFacts,
): Promise<void> => {
  const decisionSummary = recorder.decisionSummary();
  console.error(JSON.stringify({ event: "run-decision-summary", ...decisionSummary }));
  const summary = {
    ...summarize(result, facts),
    decisionSummary,
    costBudget: budget.snapshot(),
  };
  console.log(JSON.stringify({ ...summary, runDirectory: recorder.directory }, undefined, 2));
  if (outputPath !== undefined) {
    await writeFile(outputPath, `${JSON.stringify({ summary, result }, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }
};

const playResumedRun = async (
  runtime: ModelRuntime,
  recorder: RunRecorder,
  resume: RunResume,
  references: ReadonlyArray<PiModelReference>,
  budget: PiCostBudget,
  resumedSessions: ReadonlyMap<string, string> | undefined,
): Promise<MatchRunResult> =>
  Effect.runPromise(
    runGameSteps({
      config: resume.config,
      maxDecisions,
      createAgent: createAgentsFor(references, runtime, recorder, budget, resumedSessions),
      decisionTimeoutMs: outerDecisionTimeoutMs,
      maxAttempts,
      onActivity: activityRecorder(recorder),
      ...(negotiationPolicy === undefined ? {} : { negotiationPolicy }),
      resume: {
        state: resume.state,
        events: resume.events,
        eventPayloads: resume.eventPayloads,
        negotiations: resume.negotiations,
        decisionCount: resume.decisionCount,
      },
    }),
  );

/**
 * The model of every seat, in the order of the recorded players. The harness hands
 * the list to the seats by position, so the stored seat order must not decide which
 * model plays which seat.
 */
const seatModelsFromManifest = (
  manifest: RunManifest,
  playerIds: ReadonlyArray<string>,
): ReadonlyArray<PiModelReference> => {
  const seats = new Map(manifest.seats.map((seat) => [seat.seatId, seat]));
  const mismatch = "The manifest seats do not match the recorded players of the run.";
  if (seats.size !== playerIds.length) throw new Error(mismatch);
  return playerIds.map((playerId) => {
    const seat = seats.get(playerId);
    if (seat === undefined) throw new Error(mismatch);
    if (seat.agentType !== "pi" || seat.model === null) {
      throw new Error(`Seat ${playerId} has no Pi model and cannot resume.`);
    }
    return { provider: seat.model.provider, modelId: seat.model.modelId };
  });
};

const runFresh = async (
  runtime: ModelRuntime,
  thinkingLevelsApplications: ReadonlyArray<ThinkingLevelsApplication>,
): Promise<void> => {
  const references = modelReferences;
  configureProviderRouting(runtime, references);
  await applyEnvironmentAuthentication(runtime, references);
  await assertModelsAvailable(runtime, references);
  const thinkingLevels = resolveThinkingLevels(
    runtime,
    references,
    thinkingLevel,
    thinkingLevelsApplications,
  );
  console.error(
    JSON.stringify({ event: "live-test-thinking-levels", thinkingLevel, thinkingLevels }),
  );

  const bounds = runBounds(config.players.length, maxDecisions);
  const estimate = estimateCost(runtime, references, bounds);
  const budget = createBudget(estimate, 0);
  console.error(
    JSON.stringify({ event: "live-test-budget", ...budgetReport(bounds, estimate, 0, references) }),
  );

  const recorder = await RunRecorder.create({
    directory: runDirectory,
    runId,
    config,
    initialStateOrigin: { type: "generated", generatorId: STANDARD_BOARD_GENERATOR_ID, seed },
    piVersion,
    negotiationRounds: negotiationPolicy?.maxRounds ?? null,
    launch: { ...launchConfiguration, thinkingLevels },
    seats: config.players.map((player, index) => ({
      seatId: player.id,
      agentType: "pi" as const,
      model: references[index % references.length] ?? null,
    })),
  });
  console.error(JSON.stringify({ event: "run-created", runId, runDirectory }));

  const holder: { value: MatchRunResult | null } = { value: null };
  try {
    const result = await Effect.runPromise(
      runGameSteps({
        config,
        maxDecisions,
        createAgent: createAgentsFor(references, runtime, recorder, budget, undefined),
        decisionTimeoutMs: outerDecisionTimeoutMs,
        maxAttempts,
        onActivity: activityRecorder(recorder),
        ...(negotiationPolicy === undefined ? {} : { negotiationPolicy }),
      }),
    );
    holder.value = result;
    await recorder.complete(result);
    await reportResult(result, recorder, budget, {
      seed,
      models: modelReferences,
      resumed: false,
      priorDecisions: 0,
      priorSpendUsd: 0,
    });
  } catch (error) {
    if (recorder.manifest.status === "partial") {
      await recorder.fail(holder.value, "The Pi match failed.");
    }
    throw error;
  }
};

const requiredArgument = (name: string, message: string): string => {
  const value = argument(name);
  if (value === undefined) throw new Error(message);
  return value;
};

const resumeModeArgument = (): RunResumeMode => {
  const mode = requiredArgument("mode", "resume requires --mode=warm or --mode=cold.");
  if (mode !== "warm" && mode !== "cold") {
    throw new Error("resume requires --mode=warm or --mode=cold.");
  }
  return mode;
};

/**
 * A resume must keep the negotiation policy the run started with. The round limit
 * comes from the first window in the whole timeline, because a stop can leave that
 * window in the records the resume removes. Message length and open-offer limits
 * are not recorded in the timeline.
 */
const assertRecordedNegotiationRounds = (
  recorded: number | null,
  policy: NegotiationPolicy | undefined,
): void => {
  if (recorded === null) return;
  const requested = policy?.maxRounds ?? 0;
  if (requested !== recorded) {
    throw new Error(
      `The run recorded ${recorded} negotiation rounds per window, but the resume asks for ${requested}.`,
    );
  }
};

/**
 * The ceiling must cover the prefix the lock protects, not the earlier read. A
 * writer that added paid decisions in between would otherwise leave the budget
 * short of the spend the resumed run holds.
 */
const createBudgetForResume = async (
  estimate: Estimate,
  opened: OpenedRun,
): Promise<PiCostBudget> => {
  try {
    return createBudget(estimate, opened.resume.observedSpendUsd);
  } catch (error) {
    await opened.recorder.close();
    throw error;
  }
};

const runResume = async (runtime: ModelRuntime): Promise<void> => {
  requiredArgument("decisions", "resume requires --decisions=<total decisions for the whole run>.");
  const directory = resolve(requiredArgument("run-dir", "resume requires --run-dir=<path>."));
  const mode = resumeModeArgument();
  const existing = await readRunPackage(directory);
  const resume = existing.resume;
  if (resume === null) {
    throw new Error(
      existing.resumeBlockedReason === null
        ? `The run at ${directory} cannot resume.`
        : `The run at ${directory} cannot resume. ${existing.resumeBlockedReason}`,
    );
  }
  assertRecordedNegotiationRounds(resume.negotiationMaxRounds, negotiationPolicy);
  const references = seatModelsFromManifest(
    existing.manifest,
    resume.config.players.map(({ id }) => id),
  );
  configureProviderRouting(runtime, references);
  await applyEnvironmentAuthentication(runtime, references);
  await assertModelsAvailable(runtime, references);

  const bounds = runBounds(resume.config.players.length, maxDecisions);
  const estimate = estimateCost(runtime, references, bounds);

  const opened = await RunRecorder.open({
    directory,
    mode,
    reason: argument("reason") ?? "operator resume",
  });
  console.error(
    JSON.stringify({
      event: "run-resumed",
      runDirectory: opened.recorder.directory,
      mode,
      resumedAtIndex: opened.resume.nextIndex,
      restoredSeats: [...opened.sessions.keys()],
    }),
  );
  const budget = await createBudgetForResume(estimate, opened);
  console.error(
    JSON.stringify({
      event: "live-test-budget",
      ...budgetReport(bounds, estimate, opened.resume.observedSpendUsd, references),
      resumeMode: mode,
      resumedAtIndex: opened.resume.nextIndex,
    }),
  );
  const resumedSessions = mode === "warm" ? opened.sessions : undefined;

  const holder: { value: MatchRunResult | null } = { value: null };
  try {
    const result = await playResumedRun(
      runtime,
      opened.recorder,
      opened.resume,
      references,
      budget,
      resumedSessions,
    );
    holder.value = result;
    await opened.recorder.complete(result);
    await reportResult(result, opened.recorder, budget, {
      seed: opened.resume.config.seed,
      models: references,
      resumed: true,
      priorDecisions: opened.resume.decisionCount,
      priorSpendUsd: opened.resume.observedSpendUsd,
    });
  } catch (error) {
    if (opened.recorder.manifest.status === "partial") {
      await opened.recorder.fail(holder.value, "The resumed Pi match failed.");
    }
    throw error;
  }
};

const main = async (): Promise<void> => {
  const runtime = await createModelRuntime();
  const thinkingLevelsApplications = await configureThinkingLevels(runtime);
  if (subcommand === "resume") {
    await runResume(runtime);
    return;
  }
  await runFresh(runtime, thinkingLevelsApplications);
};

await main();
