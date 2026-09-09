export interface RandomState {
  readonly value: number;
}

export interface RandomResult {
  readonly state: RandomState;
  readonly value: number;
}

export interface DiceRoll {
  readonly dice: readonly [number, number];
  readonly state: RandomState;
  readonly total: number;
}

const UINT32_RANGE = 4_294_967_296;
const STEP = 0x6d2b_79f5;

export const nextUint32 = (state: RandomState): RandomResult => {
  const nextState = (state.value + STEP) >>> 0;
  const firstMix = Math.imul(nextState ^ (nextState >>> 15), nextState | 1);
  const secondMix = firstMix ^ (firstMix + Math.imul(firstMix ^ (firstMix >>> 7), firstMix | 61));
  const value = (secondMix ^ (secondMix >>> 14)) >>> 0;

  return { state: { value: nextState }, value };
};

export const rollDice = (state: RandomState): DiceRoll => {
  const first = nextUint32(state);
  const second = nextUint32(first.state);
  const firstDie = (first.value % 6) + 1;
  const secondDie = (second.value % 6) + 1;

  return {
    dice: [firstDie, secondDie],
    state: second.state,
    total: firstDie + secondDie,
  };
};

export const randomUnit = (state: RandomState): RandomResult => {
  const next = nextUint32(state);
  return { state: next.state, value: next.value / UINT32_RANGE };
};
