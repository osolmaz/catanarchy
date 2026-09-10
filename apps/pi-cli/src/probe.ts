#!/usr/bin/env node

import { createGame, legalActions, observe } from "@catanarchy/engine";
import {
  applyEnvironmentAuthentication,
  assertModelsAvailable,
  createPiAgentFactory,
  ModelRuntime,
  parseModelReference,
} from "@catanarchy/pi-agent";
import type { GameConfig } from "@catanarchy/protocol";
import { Effect } from "effect";

const modelArgument = process.argv
  .find((value) => value.startsWith("--model="))
  ?.slice("--model=".length);
if (modelArgument === undefined) {
  throw new Error("--model=provider/model-id is required.");
}
const reference = parseModelReference(modelArgument);
const runtime = await ModelRuntime.create();
await applyEnvironmentAuthentication(runtime, [reference]);
await assertModelsAvailable(runtime, [reference]);
const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "pi-model-probe",
  seed: 42,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
  ],
};
const player = config.players[0];
if (player === undefined) throw new Error("The probe player is missing.");
const state = (await Effect.runPromise(createGame(config))).state;
const agent = await createPiAgentFactory({
  models: [reference],
  modelRuntime: runtime,
  thinkingLevel: "high",
})(player);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 180_000);

const sanitizedMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Unknown model error.";
  return message
    .replace(/((?:Bearer|token|api[-_ ]?key))\s*[:=]?\s*\S+/giu, "$1 [redacted]")
    .slice(0, 500);
};

try {
  const decision = await agent.decide({
    matchId: state.matchId,
    sequence: state.sequence,
    playerId: player.id,
    turnKey: "setup:forward:0",
    observation: observe(state, { type: "player", playerId: player.id }),
    legalActions: legalActions(state),
    signal: controller.signal,
  });
  console.log(JSON.stringify({ ok: true, model: reference, decision }, undefined, 2));
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, model: reference, error: sanitizedMessage(error) }, undefined, 2),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await agent.dispose();
}
