import { createGame, handleCommand, legalActions, observe } from "@catanarchy/engine";
import type {
  CommandResult,
  GameConfig,
  GameEvent,
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

const phaseText = (state: GameState): string => {
  const player = state.config.players[state.phase.playerIndex];
  const playerName = player === undefined ? "Player" : player.name;
  switch (state.phase.tag) {
    case "setup.settlement":
      return `${playerName}: place a settlement (${state.phase.direction} round)`;
    case "setup.road":
      return `${playerName}: place an adjacent road (${state.phase.direction} round)`;
    case "setup.completing":
      return "Completing initial placement";
    case "turn.roll":
      return `${playerName}: roll the dice (turn ${state.phase.turn})`;
    case "turn.action":
      return `${playerName}: trade, build, or end turn after ${state.phase.dice.join(" + ")}`;
    case "turn.robber":
      return `${playerName}: resolve a rolled seven (planned for Milestone 3)`;
  }
};

const isBoardAction = (action: LegalAction): boolean => {
  const type = action.command.command.type;
  return (
    type === "place-initial-settlement" ||
    type === "place-initial-road" ||
    type === "build-settlement" ||
    type === "build-road" ||
    type === "build-city"
  );
};

const actionLabel = (action: LegalAction): string => {
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
      return action.id;
  }
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
  const activePlayer = state.config.players[state.phase.playerIndex];
  const observation = useMemo(
    () =>
      observe(
        state,
        activePlayer === undefined
          ? { type: "public" }
          : { type: "player", playerId: activePlayer.id },
      ),
    [activePlayer, state],
  );
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
              {actions
                .filter((action) => !isBoardAction(action))
                .map((action) => (
                  <button key={action.id} type="button" onClick={() => onAction(action)}>
                    {actionLabel(action)}
                  </button>
                ))}
              {actions.length === 0 ? <p>No action is available.</p> : null}
              {actions.length > 0 && actions.every(isBoardAction) ? (
                <p>Select a highlighted board location.</p>
              ) : null}
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
