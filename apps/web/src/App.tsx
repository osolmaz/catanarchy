import { createGame, handleCommand, legalActions, observe } from "@catanarchy/engine";
import type {
  CommandResult,
  GameConfig,
  GameEvent,
  GameState,
  LegalAction,
  NegotiationView,
  PlayerColor,
} from "@catanarchy/protocol";
import { Effect, Either } from "effect";
import { useCallback, useMemo, useState } from "react";
import { Board } from "./Board.js";
import { Controls } from "./Controls.js";
import { Feed, type FeedItem } from "./Feed.js";
import { negotiationFeedItems } from "./NegotiationTimeline.js";
import { phaseText } from "./phase.js";
import { Players } from "./Players.js";

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

const emptyNegotiation = (matchId: string): NegotiationView => ({
  schema: "catanarchy.negotiation-view.v1",
  matchId,
  sequence: 0,
  events: [],
  offers: [],
  promises: [],
  evidence: [],
});

const negotiationForMatch = (
  negotiation: NegotiationView | undefined,
  matchId: string,
): NegotiationView => (negotiation?.matchId === matchId ? negotiation : emptyNegotiation(matchId));

const handText = (resources: GameState["bank"] | null): string =>
  resources === null
    ? "Hidden"
    : `Lumber ${resources.lumber} · Brick ${resources.brick} · Wool ${resources.wool} · Grain ${resources.grain} · Ore ${resources.ore}`;

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

const eventText = (record: GameEvent): string => {
  const event = record.event;
  const actor = "playerId" in event ? `${event.playerId}: ` : "";
  const dice = event.type === "dice.rolled" ? ` ${event.dice.join(" + ")}` : "";
  return `${actor}${event.type}${dice}`;
};

const eventFeedItems = (
  events: ReadonlyArray<GameEvent>,
  through: number,
): ReadonlyArray<FeedItem> =>
  events
    .filter((event) => event.sequence <= through)
    .map((event) => ({
      key: `event:${event.sequence}`,
      sequence: event.sequence,
      order: 0,
      kind: "event",
      text: eventText(event),
    }));

interface ActionControlsProps {
  readonly actions: ReadonlyArray<LegalAction>;
  readonly onAction: (action: LegalAction) => void;
}

const ActionControls = ({ actions, onAction }: ActionControlsProps) => {
  if (actions.length === 0) return <p className="empty">No action is available.</p>;
  if (actions.every(isBoardAction)) {
    return <p className="empty">Select a highlighted board location.</p>;
  }
  return (
    <div className="actions">
      {actions
        .filter((action) => !isBoardAction(action))
        .map((action) => (
          <button key={action.id} type="button" onClick={() => onAction(action)}>
            {actionLabel(action)}
          </button>
        ))}
    </div>
  );
};

interface NewGameFormProps {
  readonly onStart: (seed: number, playerCount: number) => void;
}

const NewGameForm = ({ onStart }: NewGameFormProps) => {
  const [seedInput, setSeedInput] = useState("42");
  const [playerCount, setPlayerCount] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const submit = (): void => {
    const seed = Number(seedInput);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      setError("Seed must be an unsigned 32-bit integer.");
      return;
    }
    setError(null);
    onStart(seed, playerCount);
  };
  return (
    <form
      className="new-game"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
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
      {error === null ? null : <p className="error">{error}</p>}
    </form>
  );
};

export interface AppProps {
  readonly negotiation?: NegotiationView;
}

export const App = ({ negotiation }: AppProps = {}) => {
  const [game, setGame] = useState<LocalGame>(() => startGame(42, 4));
  const [frameIndex, setFrameIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const latestIndex = game.states.length - 1;
  const state = game.states[frameIndex] ?? game.states[latestIndex]!;
  const isLive = frameIndex === latestIndex;
  const observation = useMemo(() => activePlayerObservation(state), [state]);
  const actions = isLive ? legalActions(state) : [];
  const items = [
    ...eventFeedItems(game.events, state.sequence),
    ...negotiationFeedItems(
      negotiationForMatch(negotiation, state.matchId),
      game.events,
      state.sequence,
    ),
  ];

  const onStart = useCallback((seed: number, playerCount: number): void => {
    setGame(startGame(seed, playerCount));
    setFrameIndex(0);
    setError(null);
  }, []);

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

  const cards = observation.ownDevelopmentCards;

  return (
    <main className="viewer">
      <div className="board-pane">
        <Board
          observation={observation}
          legalActions={actions}
          onAction={onAction}
          interactive={isLive}
        />
      </div>
      <Controls index={frameIndex} count={game.states.length} onSeek={setFrameIndex} />
      <aside>
        <header className="status" aria-live="polite">
          <strong>{phaseText(state)}</strong>
          <small>
            <span>{state.matchId}</span> · event {state.sequence}
          </small>
        </header>
        <NewGameForm onStart={onStart} />
        {error === null ? null : <p className="error">{error}</p>}
        <ActionControls actions={actions} onAction={onAction} />
        <Players observation={observation} />
        <p className="hand">
          <span>{handText(observation.ownResources)}</span>
          <span>
            VP <b>{observation.ownVictoryPoints ?? "Hidden"}</b> · Cards{" "}
            {cards === null || cards.length === 0
              ? "none"
              : cards.map(({ card }) => card).join(", ")}
          </span>
        </p>
        <Feed items={items} empty="No events yet." label="Game feed" />
      </aside>
    </main>
  );
};
