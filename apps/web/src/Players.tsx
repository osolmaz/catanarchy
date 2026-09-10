import type { GameObservation } from "@catanarchy/protocol";
import type { ReactNode } from "react";

interface PlayersProps {
  readonly observation: GameObservation;
  /** Extra line under a player's name, for example the model that plays the seat. */
  readonly note?: (playerId: string) => ReactNode;
}

export const Players = ({ observation, note }: PlayersProps) => (
  <table className="players">
    <thead>
      <tr>
        <th scope="col">Player</th>
        <th scope="col" title="Visible victory points">
          VP
        </th>
        <th scope="col" title="Resource cards">
          Res
        </th>
        <th scope="col" title="Development cards">
          Dev
        </th>
        <th scope="col" title="Longest route">
          Road
        </th>
        <th scope="col" title="Played knights">
          Army
        </th>
      </tr>
    </thead>
    <tbody>
      {observation.players.map((player) => (
        <tr
          key={player.id}
          className={player.id === observation.activePlayerId ? "active" : undefined}
        >
          <th scope="row">
            <span className={`swatch ${player.color}`} aria-hidden="true" />
            {player.name}
            {player.hasLongestRoad ? <abbr title="Longest Road">LR</abbr> : null}
            {player.hasLargestArmy ? <abbr title="Largest Army">LA</abbr> : null}
            {note === undefined ? null : <small>{note(player.id)}</small>}
          </th>
          <td>{player.visibleVictoryPoints}</td>
          <td>{player.resourceCount}</td>
          <td>{player.developmentCardCount}</td>
          <td>{player.longestRoadLength}</td>
          <td>{player.playedKnights}</td>
        </tr>
      ))}
    </tbody>
  </table>
);
