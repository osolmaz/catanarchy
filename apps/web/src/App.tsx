import { createGame, handleCommand, legalActions, observe } from "@catanarchy/engine";
import type {
  CommandResult,
  GameConfig,
  GameEvent,
  GamePhase,
  GameState,
  LegalAction,
  PlayerColor,
} from "@catanarchy/protocol";
import { Effect, Either } from "effect";
import { useMemo, useState } from "react";
import { Board } from "./Board.js";

interface LocalGame {
  readonly states: ReadonlyArray<GameState>;
  readonly events: ReadonlyArray<GameEvent>;
}

const COLORS: ReadonlyArray<PlayerColor> = ["red", "blue", "white", "orange"];

const makeConfig = (seed: number, playerCount: number): GameConfig => ({
  schema: "catanarchy.game-config.v1",
  matchId: `local-${seed}-${playerCount}`,
  seed,
  players: COLORS.slice(0, playerCount).map((color) => ({
    id: color,
    name: color.slice(0, 1).toUpperCase() + color.slice(1),
    color,
  })),
});

const startGame = (seed: number, playerCount: number): LocalGame => {
  const result = Effect.runSync(createGame(makeConfig(seed, playerCount)));
  return { states: [result.state], events: result.events };
};

const resourceText = (resources: GameState["bank"] | null): string =>
  resources === null
    ? "Hidden"
    : `Lumber ${resources.lumber} · Brick ${resources.brick} · Wool ${resources.wool} · Grain ${resources.grain} · Ore ${resources.ore}`;

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
  }
};

const phaseText = (state: GameState): string => {
  const playerName = state.config.players[state.phase.playerIndex]?.name ?? "Player";
  return state.phase.tag.startsWith("setup.")
    ? setupPhaseText(state.phase as SetupPhase, playerName)
    : turnPhaseText(state.phase as TurnPhase, playerName);
};

const BOARD_ACTIONS = new Set([
  "place-initial-settlement",
  "place-initial-road",
  "build-settlement",
  "build-road",
  "place-free-road",
  "build-city",
]);

const isBoardAction = (action: LegalAction): boolean =>
  BOARD_ACTIONS.has(action.command.command.type);

const normalActionLabel = (action: LegalAction): string | undefined => {
  const command = action.command.command;
  switch (command.type) {
    case "roll-dice":
      return "Roll dice";
    case "buy-development-card":
      return "Buy development card";
    case "maritime-trade":
      return `Trade ${command.give} for ${command.receive}`;
    case "end-turn":
      return "End turn";
    default:
      return undefined;
  }
};

const effectActionLabel = (action: LegalAction): string | undefined => {
  const command = action.command.command;
  switch (command.type) {
    case "discard-resource":
      return `Discard ${command.resource}`;
    case "move-robber": {
      const victim = command.victimPlayerId === null ? "" : ` and rob ${command.victimPlayerId}`;
      return `Move robber to ${command.hexId}${victim}`;
    }
    case "play-knight":
      return "Play Knight";
    case "play-road-building":
      return "Play Road Building";
    case "play-year-of-plenty":
      return `Play Year of Plenty: ${command.resources.join(" + ")}`;
    case "play-monopoly":
      return `Play Monopoly: ${command.resource}`;
    default:
      return undefined;
  }
};

const actionLabel = (action: LegalAction): string =>
  normalActionLabel(action) ?? effectActionLabel(action) ?? action.id;

const activePlayerObservation = (state: GameState) => {
  const player = state.config.players[state.phase.playerIndex];
  return observe(
    state,
    player === undefined ? { type: "public" } : { type: "player", playerId: player.id },
  );
};

interface ActionControlsProps {
  readonly actions: ReadonlyArray<LegalAction>;
  readonly onAction: (action: LegalAction) => void;
}

const ActionControls = ({ actions, onAction }: ActionControlsProps) => {
  const buttons = actions
    .filter((action) => !isBoardAction(action))
    .map((action) => (
      <button key={action.id} type="button" onClick={() => onAction(action)}>
        {actionLabel(action)}
      </button>
    ));
  if (actions.length === 0) return <p>No action is available.</p>;
  if (actions.every(isBoardAction)) return <p>Select a highlighted board location.</p>;
  return buttons;
};

export const App = () => {
  const [seedInput, setSeedInput] = useState("42");
  const [playerCount, setPlayerCount] = useState(4);
  const [game, setGame] = useState<LocalGame>(() => startGame(42, 4));
  const [frameIndex, setFrameIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const latestIndex = game.states.length - 1;
  const state = game.states[frameIndex] ?? game.states[latestIndex]!;
  const isLive = frameIndex === latestIndex;
  const observation = useMemo(() => activePlayerObservation(state), [state]);
  const actions = isLive ? legalActions(state) : [];

  const onNewGame = () => {
    const seed = Number(seedInput);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      setError("Seed must be an unsigned 32-bit integer.");
      return;
    }
    setGame(startGame(seed, playerCount));
    setFrameIndex(0);
    setError(null);
  };

  const onAction = (action: LegalAction) => {
    if (!isLive) return;
    const handled = Effect.runSync(Effect.either(handleCommand(state, action.command)));
    if (Either.isLeft(handled)) {
      setError(handled.left.message);
      return;
    }
    const result: CommandResult = handled.right;
    setGame((current) => ({
      states: [...current.states, result.state],
      events: [...current.events, ...result.events],
    }));
    setFrameIndex(latestIndex + 1);
    setError(null);
  };

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">Catanarchy simulator</p>
          <h1>Play a deterministic game</h1>
          <p className="subtitle">
            Place pieces, roll for production, build, use maritime trade, and inspect the event
            history.
          </p>
        </div>
        <form
          className="new-game"
          onSubmit={(event) => {
            event.preventDefault();
            onNewGame();
          }}
        >
          <label>
            Seed
            <input
              value={seedInput}
              inputMode="numeric"
              onChange={(event) => setSeedInput(event.target.value)}
            />
          </label>
          <label>
            Players
            <select
              value={playerCount}
              onChange={(event) => setPlayerCount(Number(event.target.value))}
            >
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </label>
          <button type="submit">New game</button>
        </form>
      </header>

      {error === null ? null : <p className="error">{error}</p>}

      <section className="status-card" aria-live="polite">
        <div>
          <span>Match</span>
          <strong>{state.matchId}</strong>
        </div>
        <div>
          <span>Event sequence</span>
          <strong>{state.sequence}</strong>
        </div>
        <div className="phase-status">
          <span>Next action</span>
          <strong>{phaseText(state)}</strong>
        </div>
      </section>

      <section className="game-grid">
        <div className="board-panel">
          <Board
            observation={observation}
            legalActions={actions}
            onAction={onAction}
            interactive={isLive}
          />
          <div className="replay-controls" aria-label="Replay controls">
            <button type="button" disabled={frameIndex === 0} onClick={() => setFrameIndex(0)}>
              First
            </button>
            <button
              type="button"
              disabled={frameIndex === 0}
              onClick={() => setFrameIndex((value) => value - 1)}
            >
              Previous
            </button>
            <span>
              Frame {frameIndex + 1} of {game.states.length}
            </span>
            <button
              type="button"
              disabled={frameIndex === latestIndex}
              onClick={() => setFrameIndex((value) => value + 1)}
            >
              Next
            </button>
            <button type="button" disabled={isLive} onClick={() => setFrameIndex(latestIndex)}>
              Live
            </button>
          </div>
        </div>

        <aside>
          <section className="panel">
            <h2>Actions</h2>
            <div className="turn-actions">
              <ActionControls actions={actions} onAction={onAction} />
            </div>
          </section>

          <section className="panel">
            <h2>Players</h2>
            <div className="players">
              {observation.players.map((player) => (
                <article
                  key={player.id}
                  className={player.id === observation.activePlayerId ? "player active" : "player"}
                >
                  <span className={`player-dot ${player.color}`} />
                  <div>
                    <strong>{player.name}</strong>
                    <small>
                      {player.settlements} settlements · {player.cities} cities · {player.roads}{" "}
                      roads · {player.resourceCount} resources · {player.developmentCardCount}{" "}
                      development cards
                    </small>
                  </div>
                </article>
              ))}
            </div>
            <h3>Active hand</h3>
            <p className="resource-line">{resourceText(observation.ownResources)}</p>
            <h3>Development cards</h3>
            <p className="resource-line">
              {observation.ownDevelopmentCards === null ||
              observation.ownDevelopmentCards.length === 0
                ? "None"
                : observation.ownDevelopmentCards.map(({ card }) => card).join(" · ")}
            </p>
          </section>

          <section className="panel">
            <h2>Event log</h2>
            <ol className="events">
              {game.events.map((event) => (
                <li
                  key={`${event.sequence}:${event.event.type}`}
                  className={event.sequence <= state.sequence ? "visible" : "future"}
                >
                  <code>{event.sequence}</code>
                  <span>{event.event.type}</span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </section>
    </main>
  );
};
