import { describe, expect, it } from "vitest";
import { nextUint32, randomUnit, rollDice } from "../src/engine/random.js";

describe("seeded random source", () => {
  it("repeats the same sequence from the same state", () => {
    expect(nextUint32({ value: 42 })).toEqual(nextUint32({ value: 42 }));
    expect(rollDice({ value: 42 })).toEqual(rollDice({ value: 42 }));
  });

  it("advances without changing the input state", () => {
    const state = { value: 42 } as const;
    const result = nextUint32(state);

    expect(state.value).toBe(42);
    expect(result.state.value).not.toBe(state.value);
  });

  it("produces legal dice and unit values", () => {
    const dice = rollDice({ value: 7 });
    const unit = randomUnit(dice.state);

    expect(dice.dice[0]).toBeGreaterThanOrEqual(1);
    expect(dice.dice[0]).toBeLessThanOrEqual(6);
    expect(dice.dice[1]).toBeGreaterThanOrEqual(1);
    expect(dice.dice[1]).toBeLessThanOrEqual(6);
    expect(dice.total).toBe(dice.dice[0] + dice.dice[1]);
    expect(unit.value).toBeGreaterThanOrEqual(0);
    expect(unit.value).toBeLessThan(1);
  });
});
