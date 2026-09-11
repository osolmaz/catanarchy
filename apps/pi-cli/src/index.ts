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
} from "@catanarchy/harness";
import {
  applyEnvironmentAuthentication,
  assertModelsAvailable,
  createPiAgentFactory,
  ModelRuntime,
  parseModelReference,
  PiCostBudget,
  pinOpenRouterProvider,
  withPiCostBudget,
  type PiAgentFactoryOptions,
  type PiModelReference,
} from "@catanarchy/pi-agent";
import type { GameConfig } from "@catanarchy/protocol";
import { RunRecorder } from "@catanarchy/run-log";
import { Effect } from "effect";

const argument = (name: string): string | undefined =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

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
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
  if (!levels.has(value)) throw new Error("--thinking is not a supported thinking level.");
  return value as NonNullable<PiAgentFactoryOptions["thinkingLevel"]>;
};

const seed = integerArgument("seed", 42, 0, 0xffff_ffff);
const turnTimeMs = integerArgument("turn-time-ms", 600_000, 1, 0x7fff_ffff);
const finalizationGraceMs = integerArgument("finalization-grace-ms", 60_000, 1, 0x7fff_ffff);
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
const outputPath = argument("output");
const modelsPath = argument("models-path");
const modelsPathReport = modelsPath === undefined ? null : resolve(modelsPath);
const openRouterProvider = argument("openrouter-provider");
const openRouterProviderReport = openRouterProvider ?? null;
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

const setupDecisionCount = config.players.length * 4;
const maximumNegotiationWindows = Math.max(0, Math.floor((maxDecisions - setupDecisionCount) / 2));
const maximumRequests =
  maxDecisions * maxAttempts +
  maximumNegotiationWindows * config.players.length * negotiationRounds * maxAttempts;
const maximumModelMessagesPerRequest = maxPlanningSteps + 2;
// Each model message can make the original call, two overflow-compaction calls, one recovery retry,
// and two post-recovery compaction calls.
const maximumProviderCalls = maximumRequests * maximumModelMessagesPerRequest * 6;

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
    lowUsd: maximumRequests * lowPerRequest,
    highUsd: maximumProviderCalls * highPerRequest,
    nextRequestHighUsd: maximumModelMessagesPerRequest * 6 * highPerRequest,
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

const summarize = (result: MatchRunResult) => ({
  matchId: result.state.matchId,
  modelsPath: modelsPathReport,
  openRouterProvider: openRouterProviderReport,
  seed,
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
  models: modelReferences,
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

const configureProviderRouting = (runtime: ModelRuntime): void => {
  if (openRouterProvider !== undefined) {
    pinOpenRouterProvider(runtime, modelReferences, openRouterProvider);
  }
};

const main = async (): Promise<void> => {
  const runtime = await createModelRuntime();
  configureProviderRouting(runtime);
  await applyEnvironmentAuthentication(runtime, modelReferences);
  await assertModelsAvailable(runtime, modelReferences);

  const estimate = estimateCost(runtime, modelReferences);
  if (estimate.nextRequestHighUsd > costCeilingUsd) {
    throw new Error(
      `The next request can cost up to $${estimate.nextRequestHighUsd.toFixed(4)}, above the $${costCeilingUsd.toFixed(2)} cost ceiling.`,
    );
  }
  const costBudget = new PiCostBudget(costCeilingUsd, estimate.nextRequestHighUsd);
  console.error(
    JSON.stringify({
      event: "live-test-budget",
      lowUsd: Number(estimate.lowUsd.toFixed(6)),
      highUsd: Number(estimate.highUsd.toFixed(6)),
      nextRequestHighUsd: Number(estimate.nextRequestHighUsd.toFixed(6)),
      ceilingUsd: costCeilingUsd,
      maximumRequests,
      maximumModelMessagesPerRequest,
      maximumProviderCalls,
      maxOutputTokens: maxOutputTokens ?? null,
      contextWindowTokens,
      thinkingLevel,
      turnTimeMs,
      finalizationGraceMs,
      maxPlanningSteps,
      negotiationRounds,
      modelsPath: modelsPathReport,
      openRouterProvider: openRouterProviderReport,
      pauseAfterDecisions: pauseAfterDecisionsReport,
      resumeSignalPath,
      note: "The providers do not expose an immutable per-run billing cap. The fixed request and token limits bound this smoke test.",
    }),
  );

  const recorder = await RunRecorder.create({
    directory: runDirectory,
    runId,
    config,
    initialStateOrigin: { type: "generated", generatorId: STANDARD_BOARD_GENERATOR_ID, seed },
    piVersion,
    seats: config.players.map((player, index) => ({
      seatId: player.id,
      agentType: "pi" as const,
      model: modelReferences[index % modelReferences.length] ?? null,
    })),
  });
  console.error(JSON.stringify({ event: "run-created", runId, runDirectory }));

  let result: MatchRunResult | null = null;
  try {
    result = await Effect.runPromise(
      runGameSteps({
        config,
        maxDecisions,
        createAgent: withPiCostBudget(
          createPiAgentFactory({
            models: modelReferences,
            modelRuntime: runtime,
            thinkingLevel,
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            contextWindowTokens,
            turnTimeMs,
            finalizationGraceMs,
            maxPlanningSteps,
            sessionDirectory: recorder.sessionsDirectory,
            onSessionCreated: async (player, session) =>
              recorder.registerPiSession(player.id, session),
          }),
          costBudget,
        ),
        decisionTimeoutMs: outerDecisionTimeoutMs,
        maxAttempts,
        onActivity: activityRecorder(recorder),
        ...(negotiationRounds === 0
          ? {}
          : {
              negotiationPolicy: {
                maxRounds: negotiationRounds,
                maxMessageLength,
                maxOpenOffers,
              },
            }),
      }),
    );
    await recorder.complete(result);
  } catch (error) {
    if (recorder.manifest.status === "partial") {
      await recorder.fail(result, "The Pi match failed.");
    }
    throw error;
  }

  const summary = { ...summarize(result), costBudget: costBudget.snapshot() };
  console.log(JSON.stringify({ ...summary, runDirectory }, undefined, 2));
  if (outputPath !== undefined) {
    await writeFile(outputPath, `${JSON.stringify({ summary, result }, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }
};

await main();
