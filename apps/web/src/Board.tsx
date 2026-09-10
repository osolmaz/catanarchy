import type {
  EdgeId,
  GameObservation,
  HarborKind,
  LegalAction,
  PlayerColor,
  Terrain,
  VertexId,
} from "@catanarchy/protocol";
import type { KeyboardEvent } from "react";

const SQRT_THREE = Math.sqrt(3);
const SCALE = 42;
const ORIGIN_X = 270;
const ORIGIN_Y = 230;
const VIEW_BOX = "40 0 460 460";
const TERRAIN_FILL: Readonly<Record<Terrain, string>> = {
  forest: "#4c7a58",
  hill: "#b8623f",
  pasture: "#8fbe6a",
  field: "#d9b95a",
  mountain: "#7c848d",
  desert: "#dcc28c",
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

type Geometry = {
  readonly vertexPoint: (id: VertexId) => Point;
  readonly edgePoints: (id: EdgeId) => readonly [Point, Point];
};

const point = (x: number, y: number): Point => ({
  x: ORIGIN_X + (SCALE * x) / 2,
  y: ORIGIN_Y + (SCALE * SQRT_THREE * y) / 2,
});

const geometry = (observation: GameObservation): Geometry => {
  const vertices = new Map(
    observation.topology.vertices.map((vertex) => [vertex.id, point(vertex.x, vertex.y)]),
  );
  const edges = new Map(observation.topology.edges.map((edge) => [edge.id, edge.vertexIds]));
  const vertexPoint = (id: VertexId): Point => vertices.get(id)!;
  return {
    vertexPoint,
    edgePoints: (id: EdgeId) => {
      const [a, b] = edges.get(id)!;
      return [vertexPoint(a), vertexPoint(b)];
    },
  };
};

const playerColor = (observation: GameObservation, playerId: string): string => {
  const player = observation.players.find(({ id }) => id === playerId);
  return player === undefined ? "#222" : PLAYER_FILL[player.color];
};

const midpoint = ([a, b]: readonly [Point, Point]): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const HARBOR_OFFSET = 31;
const HARBOR_CHIP = { width: 34, height: 18 };

const harborRatio = (kind: HarborKind): string => (kind === "generic" ? "3:1" : "2:1");

const harborResource = (kind: HarborKind): string => (kind === "generic" ? "any" : kind);

/** Unit normal of the edge that points away from the board center. */
const outwardNormal = ([a, b]: readonly [Point, Point]): Point => {
  const mid = midpoint([a, b]);
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  const outward = (mid.x - ORIGIN_X) * normal.x + (mid.y - ORIGIN_Y) * normal.y;
  return outward < 0 ? { x: -normal.x, y: -normal.y } : normal;
};

const probabilityPips = (number: number): number => 6 - Math.abs(7 - number);

const polygonPoints = (points: ReadonlyArray<Point>): string =>
  points.map(({ x, y }) => `${x},${y}`).join(" ");

/** A house: square base with a gabled roof. */
const settlementPath = ({ x, y }: Point, s = 8): string =>
  polygonPoints([
    { x: x - s, y: y + s },
    { x: x - s, y: y - s * 0.15 },
    { x, y: y - s * 1.05 },
    { x: x + s, y: y - s * 0.15 },
    { x: x + s, y: y + s },
  ]);

/** A tower with a lower house attached on its right side. */
const cityPath = ({ x, y }: Point, s = 8): string =>
  polygonPoints([
    { x: x - 1.2 * s, y: y + s },
    { x: x - 1.2 * s, y: y - 0.9 * s },
    { x: x - 0.7 * s, y: y - 1.5 * s },
    { x: x - 0.2 * s, y: y - 0.9 * s },
    { x: x - 0.2 * s, y: y - 0.1 * s },
    { x: x + 0.5 * s, y: y - 0.65 * s },
    { x: x + 1.2 * s, y: y - 0.1 * s },
    { x: x + 1.2 * s, y: y + s },
  ]);

const NumberToken = ({ center, number }: { center: Point; number: number }) => {
  const pips = probabilityPips(number);
  const hot = number === 6 || number === 8;
  return (
    <g data-number-token={number} aria-label={`${number} with ${pips} probability pips`}>
      <circle cx={center.x} cy={center.y} r="15" className="number-token" />
      <text
        x={center.x}
        y={center.y + 3.5}
        textAnchor="middle"
        className={hot ? "number-label hot" : "number-label"}
      >
        {number}
      </text>
      <g data-probability-pips={pips} className={hot ? "pips hot" : "pips"}>
        {Array.from({ length: pips }, (_, index) => (
          <circle
            key={index}
            cx={center.x + (index - (pips - 1) / 2) * 3.6}
            cy={center.y + 9.5}
            r="1.2"
          />
        ))}
      </g>
    </g>
  );
};

const Robber = ({ at, hexId }: { at: Point; hexId: string }) => (
  <g className="robber" transform={`translate(${at.x} ${at.y})`} aria-label={`Robber on ${hexId}`}>
    <path d="M-5.5,8 L-5.5,6 Q-5.5,4 -3.5,3 L-2.5,-1.5 L2.5,-1.5 L3.5,3 Q5.5,4 5.5,6 L5.5,8 Z" />
    <circle cx="0" cy="-5.5" r="3.6" />
  </g>
);

const HexLayer = ({
  observation,
  geometry: g,
}: {
  observation: GameObservation;
  geometry: Geometry;
}) => {
  const terrainByHex = new Map(observation.layout.terrain.map((it) => [it.hexId, it.terrain]));
  const numberByHex = new Map(observation.layout.numbers.map((it) => [it.hexId, it.number]));
  return (
    <g className="terrain-layer">
      {observation.topology.hexes.map((hex) => {
        const center = point(3 * hex.q, 2 * hex.r + hex.q);
        const terrain = terrainByHex.get(hex.id) ?? "desert";
        const number = numberByHex.get(hex.id);
        return (
          <g key={hex.id} data-hex-id={hex.id}>
            <polygon
              points={polygonPoints(hex.vertexIds.map(g.vertexPoint))}
              fill={TERRAIN_FILL[terrain]}
              className="hex"
            />
            <text
              x={center.x}
              y={center.y + (number === undefined ? 2.5 : -22)}
              textAnchor="middle"
              className="terrain-label"
            >
              {terrain}
            </text>
            {number === undefined ? null : <NumberToken center={center} number={number} />}
            {observation.layout.robberHexId === hex.id ? (
              <Robber at={{ x: center.x + 23, y: center.y - 9 }} hexId={hex.id} />
            ) : null}
          </g>
        );
      })}
    </g>
  );
};

const HarborLayer = ({
  observation,
  geometry: g,
}: {
  observation: GameObservation;
  geometry: Geometry;
}) => (
  <g className="harbor-layer">
    {observation.layout.harbors.map((harbor) => {
      const ends = g.edgePoints(harbor.edgeId);
      const mid = midpoint(ends);
      const normal = outwardNormal(ends);
      const at = { x: mid.x + normal.x * HARBOR_OFFSET, y: mid.y + normal.y * HARBOR_OFFSET };
      return (
        <g key={harbor.edgeId} data-harbor-edge={harbor.edgeId}>
          <line x1={ends[0].x} y1={ends[0].y} x2={at.x} y2={at.y} className="harbor-line" />
          <line x1={ends[1].x} y1={ends[1].y} x2={at.x} y2={at.y} className="harbor-line" />
          <rect
            x={at.x - HARBOR_CHIP.width / 2}
            y={at.y - HARBOR_CHIP.height / 2}
            width={HARBOR_CHIP.width}
            height={HARBOR_CHIP.height}
            rx="4"
            className="harbor-chip"
          />
          <text x={at.x} y={at.y - 1} textAnchor="middle" className="harbor-label">
            {harborRatio(harbor.kind)}
          </text>
          <text x={at.x} y={at.y + 6.5} textAnchor="middle" className="harbor-resource">
            {harborResource(harbor.kind)}
          </text>
        </g>
      );
    })}
  </g>
);

const RoadLayer = ({
  observation,
  geometry: g,
}: {
  observation: GameObservation;
  geometry: Geometry;
}) => (
  <g className="road-layer">
    {observation.occupancy.roads.map((road) => {
      const [a, b] = g.edgePoints(road.edgeId);
      const mid = midpoint([a, b]);
      const length = Math.hypot(b.x - a.x, b.y - a.y) - 16;
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      return (
        <rect
          key={road.edgeId}
          data-road-edge={road.edgeId}
          x={mid.x - length / 2}
          y={mid.y - 3.5}
          width={length}
          height="7"
          rx="1.5"
          transform={`rotate(${angle} ${mid.x} ${mid.y})`}
          fill={playerColor(observation, road.playerId)}
          className="road"
        />
      );
    })}
  </g>
);

const BuildingLayer = ({
  observation,
  geometry: g,
}: {
  observation: GameObservation;
  geometry: Geometry;
}) => (
  <g className="building-layer">
    {observation.occupancy.buildings.map((building) => {
      const at = g.vertexPoint(building.vertexId);
      return (
        <polygon
          key={building.vertexId}
          data-building-vertex={building.vertexId}
          points={building.kind === "city" ? cityPath(at) : settlementPath(at)}
          fill={playerColor(observation, building.playerId)}
          className={building.kind}
          aria-label={`${building.playerId} ${building.kind} on ${building.vertexId}`}
        />
      );
    })}
  </g>
);

const collectLegalBoardActions = (legalActions: ReadonlyArray<LegalAction>) => {
  const byVertex = new Map<VertexId, LegalAction>();
  const byEdge = new Map<EdgeId, LegalAction>();
  for (const action of legalActions) {
    const command = action.command.command;
    switch (command.type) {
      case "place-initial-settlement":
      case "build-settlement":
      case "build-city":
        byVertex.set(command.vertexId, action);
        break;
      case "place-initial-road":
      case "build-road":
      case "place-free-road":
        byEdge.set(command.edgeId, action);
        break;
      default:
        break;
    }
  }
  return { byVertex, byEdge };
};

const roadActionVerb = (action: LegalAction): string => {
  if (action.command.command.type === "build-road") return "Build";
  if (action.command.command.type === "place-free-road") return "Place free";
  return "Place";
};

const vertexActionVerb = (action: LegalAction): string => {
  if (action.command.command.type === "build-city") return "Build city";
  if (action.command.command.type === "build-settlement") return "Build settlement";
  return "Place settlement";
};

const activate = (action: LegalAction, onAction: (action: LegalAction) => void) => ({
  role: "button" as const,
  tabIndex: 0,
  onClick: () => onAction(action),
  onKeyDown: (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") onAction(action);
  },
});

interface LegalLayerProps {
  readonly legalActions: ReadonlyArray<LegalAction>;
  readonly geometry: Geometry;
  readonly onAction: (action: LegalAction) => void;
}

const LegalLayer = ({ legalActions, geometry: g, onAction }: LegalLayerProps) => {
  const { byVertex, byEdge } = collectLegalBoardActions(legalActions);
  return (
    <g className="legal-action-layer">
      {[...byEdge.entries()].map(([id, action]) => {
        const [a, b] = g.edgePoints(id);
        return (
          <line
            key={id}
            data-legal-edge={id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            className="legal-road"
            aria-label={`${roadActionVerb(action)} road on ${id}`}
            {...activate(action, onAction)}
          />
        );
      })}
      {[...byVertex.entries()].map(([id, action]) => {
        const at = g.vertexPoint(id);
        const city = action.command.command.type === "build-city";
        return (
          <circle
            key={id}
            data-legal-vertex={id}
            cx={at.x}
            cy={at.y}
            r={city ? 11 : 7}
            className={city ? "legal-city" : "legal-settlement"}
            aria-label={`${vertexActionVerb(action)} on ${id}`}
            {...activate(action, onAction)}
          />
        );
      })}
    </g>
  );
};

export const Board = ({ observation, legalActions, onAction, interactive }: BoardProps) => {
  const g = geometry(observation);
  return (
    <svg className="board" viewBox={VIEW_BOX} role="group" aria-label="Catan game board">
      <HexLayer observation={observation} geometry={g} />
      <HarborLayer observation={observation} geometry={g} />
      <RoadLayer observation={observation} geometry={g} />
      <BuildingLayer observation={observation} geometry={g} />
      {interactive ? (
        <LegalLayer legalActions={legalActions} geometry={g} onAction={onAction} />
      ) : null}
    </svg>
  );
};
