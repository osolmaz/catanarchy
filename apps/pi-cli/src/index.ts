#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { runGameSteps, type AgentUsage, type MatchRunResult } from "@catanarchy/harness";
import {
  applyEnvironmentAuthentication,
  assertModelsAvailable,
  createPiAgentFactory,
  ModelRuntime,
  parseModelReference,
  type PiModelReference,
} from "@catanarchy/pi-agent";
import type { GameConfig } from "@catanarchy/protocol";
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

const seed = integerArgument("seed", 42, 0, 0xffff_ffff);
const timeoutMs = integerArgument("timeout-ms", 90_000, 1, 0x7fff_ffff);
const maxAttempts = integerArgument("max-attempts", 1, 1);
const maxOutputTokens = integerArgument("max-output-tokens", 4_096, 1);
const maxDecisions = integerArgument("decisions", 16, 1);
const negotiationRounds = integerArgument("negotiation-rounds", 1, 0, 10);
const maxMessageLength = integerArgument("max-message-length", 500, 1, 10_000);
const maxOpenOffers = integerArgument("max-open-offers", 8, 1, 100);
const outputPath = argument("output");
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

const setupDecisionCount = config.players.length * 4;
const maximumNegotiationWindows = Math.max(0, Math.floor((maxDecisions - setupDecisionCount) / 2));
const maximumRequests =
  maxDecisions * maxAttempts +
  maximumNegotiationWindows * config.players.length * negotiationRounds * maxAttempts;

interface Estimate {
  readonly lowUsd: number;
  readonly highUsd: number;
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
      return modelCost(runtime, reference, model.contextWindow, maxOutputTokens, true);
    }),
  );
  return {
    lowUsd: maximumRequests * lowPerRequest,
    highUsd: maximumRequests * highPerRequest,
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

const main = async (): Promise<void> => {
  const runtime = await ModelRuntime.create();
  await applyEnvironmentAuthentication(runtime, modelReferences);
  await assertModelsAvailable(runtime, modelReferences);

  const estimate = estimateCost(runtime, modelReferences);
  const fallbackCeilingUsd = 5;
  if (estimate.highUsd >= fallbackCeilingUsd) {
    throw new Error(
      `The conservative cost estimate $${estimate.highUsd.toFixed(4)} is not below the $${fallbackCeilingUsd.toFixed(2)} live-test ceiling.`,
    );
  }
  console.error(
    JSON.stringify({
      event: "live-test-budget",
      lowUsd: Number(estimate.lowUsd.toFixed(6)),
      highUsd: Number(estimate.highUsd.toFixed(6)),
      ceilingUsd: fallbackCeilingUsd,
      maximumRequests,
      maxOutputTokens,
      negotiationRounds,
      note: "The providers do not expose an immutable per-run billing cap. The fixed request and token limits bound this smoke test.",
    }),
  );

  const result = await Effect.runPromise(
    runGameSteps({
      config,
      maxDecisions,
      createAgent: createPiAgentFactory({
        models: modelReferences,
        modelRuntime: runtime,
        thinkingLevel: "low",
        maxOutputTokens,
      }),
      decisionTimeoutMs: timeoutMs,
      maxAttempts,
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
  const summary = summarize(result);
  console.log(JSON.stringify(summary, undefined, 2));
  if (outputPath !== undefined) {
    await writeFile(outputPath, `${JSON.stringify({ summary, result }, undefined, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }
};

await main();
