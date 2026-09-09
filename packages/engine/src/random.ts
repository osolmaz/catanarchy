import type { RandomState } from "@catanarchy/protocol";

const STEP = 0x6d2b_79f5;
const UINT32_RANGE = 0x1_0000_0000;

export interface RandomResult<T> {
  readonly state: RandomState;
  readonly value: T;
}

export const createRandomState = (seed: number): RandomState => ({
  algorithm: "catanarchy-prng-v1",
  value: seed >>> 0,
  draws: 0,
});

export const nextUint32 = (state: RandomState): RandomResult<number> => {
  const nextState = (state.value + STEP) >>> 0;
  const firstMix = Math.imul(nextState ^ (nextState >>> 15), nextState | 1);
  const secondMix = firstMix ^ (firstMix + Math.imul(firstMix ^ (firstMix >>> 7), firstMix | 61));
  const value = (secondMix ^ (secondMix >>> 14)) >>> 0;

  return {
    state: { algorithm: state.algorithm, value: nextState, draws: state.draws + 1 },
    value,
  };
};

const hashLabel = (label: string): number => {
  let hash = 0x811c_9dc5;
  for (const character of label) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
};

export const deriveRandomState = (seed: number, label: string): RandomState => {
  const mixed = nextUint32(createRandomState((seed ^ hashLabel(label)) >>> 0));
  return createRandomState(mixed.value);
};

export const nextInt = (state: RandomState, bound: number): RandomResult<number> => {
  if (!Number.isSafeInteger(bound) || bound <= 0 || bound > UINT32_RANGE) {
    throw new RangeError("The random bound must be an integer from 1 through 2^32.");
  }

  const limit = Math.floor(UINT32_RANGE / bound) * bound;
  let current = state;
  for (;;) {
    const sample = nextUint32(current);
    current = sample.state;
    if (sample.value < limit) {
      return { state: current, value: sample.value % bound };
    }
  }
};

export const shuffle = <T>(
  values: ReadonlyArray<T>,
  state: RandomState,
): RandomResult<ReadonlyArray<T>> => {
  const result = [...values];
  let current = state;

  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = nextInt(current, index + 1);
    current = selected.state;
    const value = result[index];
    result[index] = result[selected.value]!;
    result[selected.value] = value!;
  }

  return { state: current, value: result };
};
