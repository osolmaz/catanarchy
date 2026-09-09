#!/usr/bin/env node

import { createGame, handleCommand, legalActions } from "@catanarchy/engine";
import type { GameConfig, GameEvent } from "@catanarchy/protocol";
import { Effect } from "effect";

const seedArgument = process.argv.find((argument) => argument.startsWith("--seed="));
const seed = Number(seedArgument?.slice("--seed=".length) ?? 42);
const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: `demo-${seed}`,
  seed,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
    { id: "orange", name: "Orange", color: "orange" },
  ],
};

const program = Effect.gen(function* () {
  const created = yield* createGame(config);
  let state = created.state;
  const events: GameEvent[] = [...created.events];

  while (state.phase.tag !== "turn.roll") {
    const action = legalActions(state)[0];
    if (action === undefined) {
      throw new Error("The scripted setup has no legal action.");
    }
    const result = yield* handleCommand(state, action.command);
    state = result.state;
    events.push(...result.events);
  }

  return {
    matchId: state.matchId,
    seed,
    sequence: state.sequence,
    phase: state.phase,
    buildings: state.occupancy.buildings.length,
    roads: state.occupancy.roads.length,
    events: events.length,
  };
});

console.log(JSON.stringify(await Effect.runPromise(program), undefined, 2));
