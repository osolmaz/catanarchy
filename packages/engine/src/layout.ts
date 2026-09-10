import type {
  AxialCoordinate,
  BoardLayout,
  DevelopmentCard,
  HarborKind,
  HexId,
  NumberPlacement,
  NumberToken,
  RandomState,
  StandardTopology,
  Terrain,
  TerrainPlacement,
} from "@catanarchy/protocol";
import { deriveRandomState, nextInt, shuffle } from "./random.js";

const TERRAIN_SUPPLY: ReadonlyArray<Terrain> = [
  "forest",
  "forest",
  "forest",
  "forest",
  "pasture",
  "pasture",
  "pasture",
  "pasture",
  "field",
  "field",
  "field",
  "field",
  "hill",
  "hill",
  "hill",
  "mountain",
  "mountain",
  "mountain",
  "desert",
];

export const STANDARD_BOARD_GENERATOR_ID = "catanarchy.standard-board.v1" as const;

export const NUMBER_SEQUENCE: ReadonlyArray<NumberToken> = [
  5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11,
];

const HARBOR_SUPPLY: ReadonlyArray<HarborKind> = [
  "generic",
  "generic",
  "generic",
  "generic",
  "lumber",
  "brick",
  "wool",
  "grain",
  "ore",
];
const HARBOR_RING_INDICES = [0, 3, 7, 10, 13, 17, 20, 23, 27] as const;
const DEVELOPMENT_DECK: ReadonlyArray<DevelopmentCard> = [
  ...Array.from({ length: 14 }, () => "knight" as const),
  "road-building",
  "road-building",
  "year-of-plenty",
  "year-of-plenty",
  "monopoly",
  "monopoly",
  ...Array.from({ length: 5 }, () => "victory-point" as const),
];
const DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
] as const;

export interface GeneratedGameMaterials {
  readonly layout: BoardLayout;
  readonly developmentDeck: ReadonlyArray<DevelopmentCard>;
  readonly boardRandom: RandomState;
  readonly developmentDeckRandom: RandomState;
}

const add = (left: AxialCoordinate, right: AxialCoordinate): AxialCoordinate => ({
  q: left.q + right.q,
  r: left.r + right.r,
});

const scale = (coordinate: AxialCoordinate, factor: number): AxialCoordinate => ({
  q: coordinate.q * factor,
  r: coordinate.r * factor,
});

const rotate = (coordinate: AxialCoordinate, turns: number): AxialCoordinate => {
  let result = coordinate;
  for (let turn = 0; turn < turns; turn += 1) {
    result = { q: -result.r, r: result.q + result.r };
  }
  return result;
};

const ring = (radius: number): ReadonlyArray<AxialCoordinate> => {
  if (radius === 0) {
    return [{ q: 0, r: 0 }];
  }
  const result: AxialCoordinate[] = [];
  let coordinate = scale(DIRECTIONS[4]!, radius);
  for (let side = 0; side < DIRECTIONS.length; side += 1) {
    for (let step = 0; step < radius; step += 1) {
      result.push(coordinate);
      coordinate = add(coordinate, DIRECTIONS[side]!);
    }
  }
  return result;
};

const spiral = (rotation: number): ReadonlyArray<AxialCoordinate> =>
  [...ring(2), ...ring(1), ...ring(0)].map((coordinate) => rotate(coordinate, rotation));

const coordinateKey = ({ q, r }: AxialCoordinate): string => `${q}:${r}`;

const assignTerrain = (
  topology: StandardTopology,
  state: RandomState,
): { readonly placements: ReadonlyArray<TerrainPlacement>; readonly state: RandomState } => {
  const shuffled = shuffle(TERRAIN_SUPPLY, state);
  return {
    placements: topology.hexes.map((hex, index) => ({
      hexId: hex.id,
      terrain: shuffled.value[index]!,
    })),
    state: shuffled.state,
  };
};

const assignNumbers = (
  topology: StandardTopology,
  terrain: ReadonlyArray<TerrainPlacement>,
  rotation: number,
): ReadonlyArray<NumberPlacement> => {
  const hexByCoordinate = new Map(topology.hexes.map((hex) => [coordinateKey(hex), hex.id]));
  const terrainByHex = new Map(terrain.map((placement) => [placement.hexId, placement.terrain]));
  const orderedHexes = spiral(rotation)
    .map((coordinate) => hexByCoordinate.get(coordinateKey(coordinate)))
    .filter((id): id is HexId => id !== undefined && terrainByHex.get(id) !== "desert");
  return orderedHexes.map((hexId, index) => ({ hexId, number: NUMBER_SEQUENCE[index]! }));
};

/**
 * Ring index of the first corner-hex middle coastal edge. Both endpoints of such an
 * edge touch only that corner hex. Starting the `3, 4, 3` pattern there reproduces the
 * physical frame: three alternating corners and every side hex carry one harbor.
 */
const harborPatternStart = (topology: StandardTopology): number => {
  const vertexById = new Map(topology.vertices.map((vertex) => [vertex.id, vertex]));
  const edgeById = new Map(topology.edges.map((edge) => [edge.id, edge]));
  const start = topology.coastalRing.findIndex((edgeId) =>
    edgeById
      .get(edgeId)!
      .vertexIds.every((vertexId) => vertexById.get(vertexId)!.adjacentHexIds.length === 1),
  );
  if (start < 0) throw new Error("The standard board coastal ring has no corner hex.");
  return start;
};

export const standardHarborEdgeIds = (
  topology: StandardTopology,
): ReadonlyArray<BoardLayout["harbors"][number]["edgeId"]> => {
  const start = harborPatternStart(topology);
  return HARBOR_RING_INDICES.map(
    (index) => topology.coastalRing[(index + start) % topology.coastalRing.length]!,
  );
};

const assignHarbors = (
  topology: StandardTopology,
  state: RandomState,
): { readonly harbors: BoardLayout["harbors"]; readonly state: RandomState } => {
  const kinds = shuffle(HARBOR_SUPPLY, state);
  const edgeOrder = new Map(topology.edges.map((edge, index) => [edge.id, index]));
  return {
    harbors: standardHarborEdgeIds(topology)
      .map((edgeId, kindIndex) => ({ edgeId, kind: kinds.value[kindIndex]! }))
      .sort((left, right) => edgeOrder.get(left.edgeId)! - edgeOrder.get(right.edgeId)!),
    state: kinds.state,
  };
};

export const generateGameMaterials = (
  topology: StandardTopology,
  seed: number,
): GeneratedGameMaterials => {
  const initialBoard = deriveRandomState(seed, "board");
  const terrain = assignTerrain(topology, initialBoard);
  const rotation = nextInt(terrain.state, 6);
  const harbors = assignHarbors(topology, rotation.state);
  const desert = terrain.placements.find((placement) => placement.terrain === "desert");
  if (desert === undefined) {
    throw new Error("The standard terrain supply must include one desert.");
  }
  const deck = shuffle(DEVELOPMENT_DECK, deriveRandomState(seed, "development-deck"));
  return {
    layout: {
      topology: "standard-radius-2",
      terrain: terrain.placements,
      numbers: assignNumbers(topology, terrain.placements, rotation.value),
      harbors: harbors.harbors,
      robberHexId: desert.hexId,
    },
    developmentDeck: deck.value,
    boardRandom: harbors.state,
    developmentDeckRandom: deck.state,
  };
};
