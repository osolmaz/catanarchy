import type {
  EdgeId,
  GameObservation,
  HarborKind,
  LegalAction,
  PlayerColor,
  Terrain,
  VertexId,
} from "@catanarchy/protocol";

const SQRT_THREE = Math.sqrt(3);
const SCALE = 42;
const ORIGIN_X = 270;
const ORIGIN_Y = 230;
const TERRAIN_FILL: Readonly<Record<Terrain, string>> = {
  forest: "#4f7d5a",
  hill: "#b96545",
  pasture: "#8ebf68",
  field: "#d7b85f",
  mountain: "#7d858e",
  desert: "#d8bd85",
};
const PLAYER_FILL: Readonly<Record<PlayerColor, string>> = {
  red: "#c6423d",
  blue: "#3169a8",
  white: "#f4f0e5",
  orange: "#d97928",
};

interface BoardProps {
  readonly observation: GameObservation;
  readonly legalActions: ReadonlyArray<LegalAction>;
  readonly onAction: (action: LegalAction) => void;
  readonly interactive: boolean;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const point = (x: number, y: number): Point => ({
  x: ORIGIN_X + (SCALE * x) / 2,
  y: ORIGIN_Y + (SCALE * SQRT_THREE * y) / 2,
});

const playerColor = (observation: GameObservation, playerId: string): string => {
  const player = observation.players.find(({ id }) => id === playerId);
  return player === undefined ? "#222" : PLAYER_FILL[player.color];
};

const harborLabel = (kind: HarborKind): string =>
  kind === "generic" ? "3:1" : `${kind.slice(0, 1).toUpperCase()} 2:1`;

export const Board = ({ observation, legalActions, onAction, interactive }: BoardProps) => {
  const vertexById = new Map(observation.topology.vertices.map((vertex) => [vertex.id, vertex]));
  const edgeById = new Map(observation.topology.edges.map((edge) => [edge.id, edge]));
  const terrainByHex = new Map(
    observation.layout.terrain.map((item) => [item.hexId, item.terrain]),
  );
  const numberByHex = new Map(observation.layout.numbers.map((item) => [item.hexId, item.number]));
  const legalByVertex = new Map<VertexId, LegalAction>();
  const legalByEdge = new Map<EdgeId, LegalAction>();
  for (const action of legalActions) {
    if (action.command.type === "place-initial-settlement") {
      legalByVertex.set(action.command.vertexId, action);
    } else {
      legalByEdge.set(action.command.edgeId, action);
    }
  }

  return (
    <svg className="board" viewBox="0 0 540 460" role="img" aria-label="Catan game board">
      <g className="terrain-layer">
        {observation.topology.hexes.map((hex) => {
          const vertices = hex.vertexIds
            .map((id) => vertexById.get(id)!)
            .map(({ x, y }) => point(x, y));
          const center = point(3 * hex.q, 2 * hex.r + hex.q);
          const terrain = terrainByHex.get(hex.id) ?? "desert";
          const number = numberByHex.get(hex.id);
          return (
            <g key={hex.id} data-hex-id={hex.id}>
              <polygon
                points={vertices.map(({ x, y }) => `${x},${y}`).join(" ")}
                fill={TERRAIN_FILL[terrain]}
                stroke="#efe5cb"
                strokeWidth="4"
              />
              <text x={center.x} y={center.y - 10} textAnchor="middle" className="terrain-label">
                {terrain}
              </text>
              {number === undefined ? null : (
                <g>
                  <circle cx={center.x} cy={center.y + 12} r="16" className="number-token" />
                  <text
                    x={center.x}
                    y={center.y + 18}
                    textAnchor="middle"
                    className={number === 6 || number === 8 ? "number-label hot" : "number-label"}
                  >
                    {number}
                  </text>
                </g>
              )}
              {observation.layout.robberHexId === hex.id ? (
                <circle
                  cx={center.x + 21}
                  cy={center.y - 23}
                  r="9"
                  className="robber"
                  aria-label={`Robber on ${hex.id}`}
                />
              ) : null}
            </g>
          );
        })}
      </g>

      <g className="harbor-layer">
        {observation.layout.harbors.map((harbor) => {
          const edge = edgeById.get(harbor.edgeId)!;
          const endpoints = edge.vertexIds
            .map((id) => vertexById.get(id)!)
            .map(({ x, y }) => point(x, y));
          const midpoint = {
            x: (endpoints[0]!.x + endpoints[1]!.x) / 2,
            y: (endpoints[0]!.y + endpoints[1]!.y) / 2,
          };
          const dx = midpoint.x - ORIGIN_X;
          const dy = midpoint.y - ORIGIN_Y;
          const length = Math.hypot(dx, dy) || 1;
          const label = { x: midpoint.x + (dx / length) * 28, y: midpoint.y + (dy / length) * 28 };
          return (
            <g key={harbor.edgeId} data-harbor-edge={harbor.edgeId}>
              <line
                x1={endpoints[0]!.x}
                y1={endpoints[0]!.y}
                x2={label.x}
                y2={label.y}
                className="harbor-line"
              />
              <line
                x1={endpoints[1]!.x}
                y1={endpoints[1]!.y}
                x2={label.x}
                y2={label.y}
                className="harbor-line"
              />
              <text x={label.x} y={label.y + 4} textAnchor="middle" className="harbor-label">
                {harborLabel(harbor.kind)}
              </text>
            </g>
          );
        })}
      </g>

      <g className="road-layer">
        {observation.occupancy.roads.map((road) => {
          const edge = edgeById.get(road.edgeId)!;
          const endpoints = edge.vertexIds
            .map((id) => vertexById.get(id)!)
            .map(({ x, y }) => point(x, y));
          return (
            <line
              key={road.edgeId}
              data-road-edge={road.edgeId}
              x1={endpoints[0]!.x}
              y1={endpoints[0]!.y}
              x2={endpoints[1]!.x}
              y2={endpoints[1]!.y}
              stroke={playerColor(observation, road.playerId)}
              className="road"
            />
          );
        })}
      </g>

      <g className="building-layer">
        {observation.occupancy.buildings.map((building) => {
          const vertex = vertexById.get(building.vertexId)!;
          const location = point(vertex.x, vertex.y);
          return (
            <rect
              key={building.vertexId}
              data-building-vertex={building.vertexId}
              x={location.x - 8}
              y={location.y - 8}
              width="16"
              height="16"
              rx="3"
              fill={playerColor(observation, building.playerId)}
              className="settlement"
              aria-label={`${building.playerId} settlement on ${building.vertexId}`}
            />
          );
        })}
      </g>

      {interactive ? (
        <g className="legal-action-layer">
          {[...legalByEdge.entries()].map(([id, action]) => {
            const edge = edgeById.get(id)!;
            const endpoints = edge.vertexIds
              .map((vertexId) => vertexById.get(vertexId)!)
              .map(({ x, y }) => point(x, y));
            return (
              <line
                key={id}
                data-legal-edge={id}
                x1={endpoints[0]!.x}
                y1={endpoints[0]!.y}
                x2={endpoints[1]!.x}
                y2={endpoints[1]!.y}
                className="legal-road"
                role="button"
                tabIndex={0}
                aria-label={`Place road on ${id}`}
                onClick={() => onAction(action)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onAction(action);
                }}
              />
            );
          })}
          {[...legalByVertex.entries()].map(([id, action]) => {
            const vertex = vertexById.get(id)!;
            const location = point(vertex.x, vertex.y);
            return (
              <circle
                key={id}
                data-legal-vertex={id}
                cx={location.x}
                cy={location.y}
                r="7"
                className="legal-settlement"
                role="button"
                tabIndex={0}
                aria-label={`Place settlement on ${id}`}
                onClick={() => onAction(action)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onAction(action);
                }}
              />
            );
          })}
        </g>
      ) : null}
    </svg>
  );
};
