import {
  createRandomState,
  deriveRandomState,
  nextInt,
  nextUint32,
  shuffle,
} from "@catanarchy/engine";
import { describe, expect, it } from "vitest";

describe("deterministic random streams", () => {
  it("repeats the same values", () => {
    expect(nextUint32(createRandomState(42))).toEqual(nextUint32(createRandomState(42)));
    expect(shuffle([1, 2, 3, 4], createRandomState(42))).toEqual(
      shuffle([1, 2, 3, 4], createRandomState(42)),
    );
  });

  it("keeps labeled streams independent", () => {
    expect(deriveRandomState(42, "board")).not.toEqual(deriveRandomState(42, "dice"));
    expect(deriveRandomState(42, "board")).toEqual(deriveRandomState(42, "board"));
  });

  it("produces bounded integers and advances its cursor", () => {
    let state = createRandomState(7);
    for (let index = 0; index < 100; index += 1) {
      const result = nextInt(state, 6);
      expect(result.value).toBeGreaterThanOrEqual(0);
      expect(result.value).toBeLessThan(6);
      state = result.state;
    }
    expect(state.draws).toBe(100);
  });

  it("retries values outside a bounded range", () => {
    const result = nextInt(createRandomState(1), 0x8000_0001);
    expect(result.state.draws).toBeGreaterThanOrEqual(1);
    expect(result.value).toBeLessThan(0x8000_0001);
  });

  it.each([0, -1, 1.5, 0x1_0000_0001])("rejects invalid bound %s", (bound) => {
    expect(() => nextInt(createRandomState(1), bound)).toThrow(RangeError);
  });
});
