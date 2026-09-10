import type { GamePhase, GameState } from "@catanarchy/protocol";

type SetupPhase = Extract<GamePhase, { readonly tag: `setup.${string}` }>;
type TurnPhase = Exclude<GamePhase, SetupPhase>;

const setupPhaseText = (phase: SetupPhase, playerName: string): string => {
  switch (phase.tag) {
    case "setup.settlement":
      return `${playerName}: place a settlement (${phase.direction} round)`;
    case "setup.road":
      return `${playerName}: place an adjacent road (${phase.direction} round)`;
    case "setup.completing":
      return "Completing initial placement";
  }
};

const turnPhaseText = (phase: TurnPhase, playerName: string): string => {
  switch (phase.tag) {
    case "turn.roll":
      return `${playerName}: roll the dice (turn ${phase.turn})`;
    case "turn.action":
      return `${playerName}: trade, build, play a card, or end turn after ${phase.dice.join(" + ")}`;
    case "turn.discard":
      return `${playerName}: discard ${phase.remaining} resource cards`;
    case "turn.robber":
      return `${playerName}: move the robber (${phase.source})`;
    case "turn.free-road":
      return `${playerName}: place ${phase.remaining} free road${phase.remaining === 1 ? "" : "s"}`;
    case "game.finished":
      return `${playerName}: game complete`;
  }
};

export const phaseText = (state: GameState): string => {
  const playerName = state.config.players[state.phase.playerIndex]?.name ?? "Player";
  if (state.result !== null) {
    return `${playerName} won with ${state.result.victoryPoints} victory points`;
  }
  return state.phase.tag.startsWith("setup.")
    ? setupPhaseText(state.phase as SetupPhase, playerName)
    : turnPhaseText(state.phase as TurnPhase, playerName);
};
