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
const VIEW_BOX = "20 0 500 460";
const TILE_WIDTH = SCALE * SQRT_THREE;
const TILE_HEIGHT = SCALE * 2;
const NUMBER_TOKEN_OFFSET_Y = 14;
const NUMBER_TOKEN_SIZE = 24;
const SHORE_ART_SIZE = TILE_HEIGHT;
const PORT_ART_SIZE = 35;
const DOCK_ART_SIZE = 33;
const TERRAIN_ART: Readonly<Record<Terrain, string>> = {
  forest: "/assets/colonist/tile-forest.svg",
  hill: "/assets/colonist/tile-hill.svg",
  pasture: "/assets/colonist/tile-pasture.svg",
  field: "/assets/colonist/tile-field.svg",
  mountain: "/assets/colonist/tile-mountain.svg",
  desert: "/assets/colonist/tile-desert.svg",
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

/**
 * Lattice to screen. The lattice is rotated a quarter turn so hexes are pointy-top
 * in horizontal rows of 3, 4, 5, 4, 3 like the physical board. A rotation keeps the
 * counterclockwise token spiral counterclockwise on screen.
 */
const point = (x: number, y: number): Point => ({
  x: ORIGIN_X - (SCALE * SQRT_THREE * y) / 2,
  y: ORIGIN_Y + (SCALE * x) / 2,
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

const playerColor = (observation: GameObservation, playerId: string): PlayerColor =>
  observation.players.find(({ id }) => id === playerId)?.color ?? "red";

const pieceArt = (piece: "city" | "road" | "settlement", color: PlayerColor): string =>
  `/assets/colonist/${piece}-${color}.svg`;

const midpoint = ([a, b]: readonly [Point, Point]): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const HARBOR_OFFSET = 38;

const portArt = (kind: HarborKind): string => `/assets/colonist/port-${kind}.svg`;

const SHORE_ROTATION_BY_EDGES: Readonly<Record<string, string>> = {
  "3,4": "0",
  "2,3": "60",
  "1,2": "120",
  "0,1": "180",
  "0,5": "neg120",
  "4,5": "neg60",
  "3,4,5": "0",
  "2,3,4": "60",
  "1,2,3": "120",
  "0,1,2": "180",
  "0,1,5": "neg120",
  "0,4,5": "neg60",
};

const shoreArt = (edgeIndexes: ReadonlyArray<number>): string => {
  const rotation = SHORE_ROTATION_BY_EDGES[edgeIndexes.join(",")];
  if (rotation === undefined) {
    throw new Error(`A standard coastal hex has an invalid edge set: ${edgeIndexes.join(",")}.`);
  }
  return `/assets/colonist/shore-${edgeIndexes.length}-${rotation}.svg`;
};

const dockArt = (from: Point, to: Point): string => {
  const deltaX = to.x - from.x;
  const horizontal = Math.abs(deltaX) < 1 ? 0 : Math.sign(deltaX);
  const vertical = Math.sign(to.y - from.y);
  let orientation: string;
  if (horizontal === 0) orientation = vertical > 0 ? "0" : "180";
  else if (horizontal > 0) orientation = vertical > 0 ? "neg120" : "neg60";
  else orientation = vertical > 0 ? "120" : "60";
  return `/assets/colonist/dock-${orientation}.svg`;
};

/** Unit normal of the edge that points away from the board center. */
const outwardNormal = ([a, b]: readonly [Point, Point]): Point => {
  const mid = midpoint([a, b]);
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  const outward = (mid.x - ORIGIN_X) * normal.x + (mid.y - ORIGIN_Y) * normal.y;
  return outward < 0 ? { x: -normal.x, y: -normal.y } : normal;
};

const probabilityPips = (number: number): number => 6 - Math.abs(7 - number);

const NumberToken = ({ center, number }: { center: Point; number: number }) => {
  const pips = probabilityPips(number);
  const y = center.y + NUMBER_TOKEN_OFFSET_Y;
  return (
    <image
      href={`/assets/colonist/number-${number}.svg`}
      x={center.x - NUMBER_TOKEN_SIZE / 2}
      y={y - NUMBER_TOKEN_SIZE / 2}
      width={NUMBER_TOKEN_SIZE}
      height={NUMBER_TOKEN_SIZE}
      className="number-art"
      data-number-token={number}
      data-probability-pips={pips}
      aria-label={`${number} with ${pips} probability pips`}
    />
  );
};

const Robber = ({ at, hexId }: { at: Point; hexId: string }) => (
  <image
    href="/assets/colonist/robber.svg"
    x={at.x - 12}
    y={at.y - 12}
    width="24"
    height="24"
    className="board-piece robber"
    aria-label={`Robber on ${hexId}`}
  />
);

const HexLayer = ({ observation }: { observation: GameObservation }) => {
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
            <title>{`${terrain} terrain on ${hex.id}`}</title>
            <image
              href={TERRAIN_ART[terrain]}
              x={center.x - TILE_WIDTH / 2}
              y={center.y - TILE_HEIGHT / 2}
              width={TILE_WIDTH}
              height={TILE_HEIGHT}
              className="terrain-art"
              data-terrain-art={terrain}
            />
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

const ShoreLayer = ({ observation }: { observation: GameObservation }) => {
  const coastalEdges = new Set(observation.topology.coastalRing);
  return (
    <g className="shore-layer" aria-hidden="true">
      {observation.topology.hexes.map((hex) => {
        const edgeIndexes = hex.edgeIds
          .map((edgeId, index) => (coastalEdges.has(edgeId) ? index : -1))
          .filter((index) => index >= 0);
        if (edgeIndexes.length === 0) return null;
        const center = point(3 * hex.q, 2 * hex.r + hex.q);
        return (
          <image
            key={hex.id}
            href={shoreArt(edgeIndexes)}
            x={center.x - SHORE_ART_SIZE / 2}
            y={center.y - SHORE_ART_SIZE / 2}
            width={SHORE_ART_SIZE}
            height={SHORE_ART_SIZE}
            className="shore-art"
            data-shore-art={hex.id}
          />
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
          {ends.map((end) => {
            const center = midpoint([at, end]);
            return (
              <image
                key={`${end.x}:${end.y}`}
                href={dockArt(at, end)}
                x={center.x - DOCK_ART_SIZE / 2}
                y={center.y - DOCK_ART_SIZE / 2}
                width={DOCK_ART_SIZE}
                height={DOCK_ART_SIZE}
                className="dock-art"
              />
            );
          })}
          <image
            href={portArt(harbor.kind)}
            x={at.x - PORT_ART_SIZE / 2}
            y={at.y - PORT_ART_SIZE / 2}
            width={PORT_ART_SIZE}
            height={PORT_ART_SIZE}
            className="port-art"
            aria-label={`${harbor.kind} harbor on ${harbor.edgeId}`}
          />
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
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const color = playerColor(observation, road.playerId);
      return (
        <image
          key={road.edgeId}
          data-road-edge={road.edgeId}
          href={pieceArt("road", color)}
          x={mid.x - 4}
          y={mid.y - 18}
          width="8"
          height="36"
          transform={`rotate(${angle + 90} ${mid.x} ${mid.y})`}
          className="board-piece road"
          aria-label={`${road.playerId} road on ${road.edgeId}`}
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
      const color = playerColor(observation, building.playerId);
      const size = building.kind === "city" ? 29 : 25;
      return (
        <image
          key={building.vertexId}
          data-building-vertex={building.vertexId}
          href={pieceArt(building.kind, color)}
          x={at.x - size / 2}
          y={at.y - size / 2}
          width={size}
          height={size}
          className={`board-piece ${building.kind}`}
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
      <ShoreLayer observation={observation} />
      <HexLayer observation={observation} />
      <HarborLayer observation={observation} geometry={g} />
      <RoadLayer observation={observation} geometry={g} />
      <BuildingLayer observation={observation} geometry={g} />
      {interactive ? (
        <LegalLayer legalActions={legalActions} geometry={g} onAction={onAction} />
      ) : null}
    </svg>
  );
};
