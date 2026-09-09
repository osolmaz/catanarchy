#!/usr/bin/env node

import { Console, Effect, pipe } from "effect";
import { createGame } from "../engine/game.js";
import { decodeGameConfig } from "../protocol/model.js";

const config: unknown = {
  schema: "catanarchy.game-config.v1",
  seed: 42,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
    { id: "orange", name: "Orange", color: "orange" },
  ],
};

const program = pipe(
  decodeGameConfig(config),
  Effect.flatMap(createGame),
  Effect.flatMap((state) => Console.log(JSON.stringify(state, undefined, 2))),
);

await Effect.runPromise(program);
