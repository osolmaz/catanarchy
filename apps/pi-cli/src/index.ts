#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import {
  runInitialPlacement,
  type AgentUsage,
  type DecisionTrace,
  type InitialPlacementResult,
} from "@catanarchy/harness";
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
const timeoutMs = integerArgument("timeout-ms", 90_000, 1);
const maxAttempts = integerArgument("max-attempts", 1, 1);
const maxOutputTokens = integerArgument("max-output-tokens", 4_096, 1);
const outputPath = argument("output");
const modelReferences = (
  argument("models") ?? "openai/gpt-5.6-luna,huggingface/deepseek-ai/DeepSeek-V4-Flash"
)
  .split(",")
  .filter((value) => value.length > 0)
  .map(parseModelReference);

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: `pi-setup-${seed}`,
  seed,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
    { id: "orange", name: "Orange", color: "orange" },
  ],
};

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
  let lowUsd = 0;
  let highUsd = 0;
  for (let seat = 0; seat < config.players.length; seat += 1) {
    const reference = references[seat % references.length];
    if (reference === undefined) {
      throw new Error("At least one model reference is required.");
    }
    const decisionsPerSeat = 4 * maxAttempts;
    lowUsd += decisionsPerSeat * modelCost(runtime, reference, 8_000, 100, false);
    highUsd += decisionsPerSeat * modelCost(runtime, reference, 64_000, maxOutputTokens, true);
  }
  return { lowUsd, highUsd };
};

const EMPTY_USAGE: AgentUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
};

const traceUsage = (decision: DecisionTrace): AgentUsage => decision.usage ?? EMPTY_USAGE;

const totalUsage = (result: InitialPlacementResult): AgentUsage =>
  result.decisions.reduce<AgentUsage>((usage, decision) => {
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

const summarize = (result: InitialPlacementResult) => ({
  matchId: result.state.matchId,
  seed,
  sequence: result.state.sequence,
  phase: result.state.phase,
  buildings: result.state.occupancy.buildings.length,
  roads: result.state.occupancy.roads.length,
  decisions: result.decisions.filter(({ outcome }) => outcome !== "failed").length,
  failures: result.decisions.filter(({ outcome }) => outcome === "failed").length,
  fallbacks: result.decisions.filter(({ outcome }) => outcome === "fallback").length,
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
      maximumRequests: config.players.length * 4 * maxAttempts,
      maxOutputTokens,
      note: "The providers do not expose an immutable per-run billing cap. The fixed request and token limits bound this smoke test.",
    }),
  );

  const result = await Effect.runPromise(
    runInitialPlacement({
      config,
      createAgent: createPiAgentFactory({
        models: modelReferences,
        modelRuntime: runtime,
        thinkingLevel: "low",
        maxOutputTokens,
      }),
      decisionTimeoutMs: timeoutMs,
      maxAttempts,
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
