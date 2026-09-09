import type {
  AxialCoordinate,
  EdgeId,
  HexId,
  StandardTopology,
  TopologyEdge,
  TopologyHex,
  TopologyVertex,
  VertexCoordinate,
  VertexId,
} from "@catanarchy/protocol";

const RADIUS = 2;
const CORNER_OFFSETS = [
  { x: 2, y: 0 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: -2, y: 0 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
] as const;
const AXIAL_DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
] as const;

interface MutableVertex extends VertexCoordinate {
  readonly id: VertexId;
  readonly adjacentHexIds: Set<HexId>;
  readonly adjacentVertexIds: Set<VertexId>;
  readonly edgeIds: Set<EdgeId>;
}

interface MutableEdge {
  readonly id: EdgeId;
  readonly vertexIds: readonly [VertexId, VertexId];
  readonly adjacentHexIds: Set<HexId>;
}

const hexId = ({ q, r }: AxialCoordinate): HexId => `h:${q}:${r}`;
const vertexId = ({ x, y }: VertexCoordinate): VertexId => `v:${x}:${y}`;
const axialKey = ({ q, r }: AxialCoordinate): string => `${q}:${r}`;

const compareCoordinates = (left: VertexCoordinate, right: VertexCoordinate): number =>
  left.y - right.y || left.x - right.x;

const edgeId = (
  left: MutableVertex,
  right: MutableVertex,
): readonly [EdgeId, readonly [VertexId, VertexId]] => {
  const vertices =
    compareCoordinates(left, right) <= 0
      ? ([left.id, right.id] as const)
      : ([right.id, left.id] as const);
  return [`e:${vertices[0]}|${vertices[1]}`, vertices];
};

const axialCoordinates = (): ReadonlyArray<AxialCoordinate> => {
  const result: AxialCoordinate[] = [];
  for (let q = -RADIUS; q <= RADIUS; q += 1) {
    for (let r = -RADIUS; r <= RADIUS; r += 1) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= RADIUS) {
        result.push({ q, r });
      }
    }
  }
  return result.sort((left, right) => left.r - right.r || left.q - right.q);
};

const cornerCoordinate = (hex: AxialCoordinate, cornerIndex: number): VertexCoordinate => {
  const offset = CORNER_OFFSETS[cornerIndex];
  if (offset === undefined) {
    throw new RangeError("A hex corner index must be from zero through five.");
  }
  return { x: 3 * hex.q + offset.x, y: 2 * hex.r + hex.q + offset.y };
};

const getVertex = (
  vertices: Map<VertexId, MutableVertex>,
  coordinate: VertexCoordinate,
): MutableVertex => {
  const id = vertexId(coordinate);
  const existing = vertices.get(id);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutableVertex = {
    id,
    ...coordinate,
    adjacentHexIds: new Set(),
    adjacentVertexIds: new Set(),
    edgeIds: new Set(),
  };
  vertices.set(id, created);
  return created;
};

const connectEdge = (
  edges: Map<EdgeId, MutableEdge>,
  left: MutableVertex,
  right: MutableVertex,
  adjacentHexId: HexId,
): EdgeId => {
  const [id, vertexIds] = edgeId(left, right);
  const edge = edges.get(id) ?? { id, vertexIds, adjacentHexIds: new Set<HexId>() };
  edge.adjacentHexIds.add(adjacentHexId);
  edges.set(id, edge);
  left.adjacentVertexIds.add(right.id);
  right.adjacentVertexIds.add(left.id);
  left.edgeIds.add(id);
  right.edgeIds.add(id);
  return id;
};

const tupleOfSix = <T>(values: ReadonlyArray<T>): readonly [T, T, T, T, T, T] => {
  if (values.length !== 6) {
    throw new Error("A regular hex must have six values.");
  }
  return [values[0]!, values[1]!, values[2]!, values[3]!, values[4]!, values[5]!];
};

const adjacentHexIds = (
  coordinate: AxialCoordinate,
  available: ReadonlySet<string>,
): ReadonlyArray<HexId> =>
  AXIAL_DIRECTIONS.map(({ q, r }) => ({ q: coordinate.q + q, r: coordinate.r + r }))
    .filter((neighbor) => available.has(axialKey(neighbor)))
    .map(hexId)
    .sort();

const addHex = (
  coordinate: AxialCoordinate,
  available: ReadonlySet<string>,
  vertices: Map<VertexId, MutableVertex>,
  edges: Map<EdgeId, MutableEdge>,
): TopologyHex => {
  const id = hexId(coordinate);
  const corners = CORNER_OFFSETS.map((_, index) =>
    getVertex(vertices, cornerCoordinate(coordinate, index)),
  );
  for (const corner of corners) {
    corner.adjacentHexIds.add(id);
  }
  const edgeIds = corners.map((corner, index) =>
    connectEdge(edges, corner, corners[(index + 1) % corners.length]!, id),
  );
  return {
    id,
    ...coordinate,
    vertexIds: tupleOfSix(corners.map((corner) => corner.id)),
    edgeIds: tupleOfSix(edgeIds),
    neighborHexIds: adjacentHexIds(coordinate, available),
  };
};

const freezeVertices = (
  vertices: ReadonlyMap<VertexId, MutableVertex>,
): ReadonlyArray<TopologyVertex> =>
  [...vertices.values()].sort(compareCoordinates).map((vertex) => ({
    id: vertex.id,
    x: vertex.x,
    y: vertex.y,
    adjacentHexIds: [...vertex.adjacentHexIds].sort(),
    adjacentVertexIds: [...vertex.adjacentVertexIds].sort(),
    edgeIds: [...vertex.edgeIds].sort(),
  }));

const freezeEdges = (edges: ReadonlyMap<EdgeId, MutableEdge>): ReadonlyArray<TopologyEdge> =>
  [...edges.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((edge) => ({
      id: edge.id,
      vertexIds: edge.vertexIds,
      adjacentHexIds: [...edge.adjacentHexIds].sort(),
    }));

const otherVertex = (edge: TopologyEdge, vertex: VertexId): VertexId =>
  edge.vertexIds[0] === vertex ? edge.vertexIds[1] : edge.vertexIds[0];

interface BoundaryIndex {
  readonly edges: ReadonlyArray<TopologyEdge>;
  readonly edgeById: ReadonlyMap<EdgeId, TopologyEdge>;
  readonly edgeIdsByVertex: ReadonlyMap<VertexId, ReadonlyArray<EdgeId>>;
}

const indexBoundary = (edges: ReadonlyArray<TopologyEdge>): BoundaryIndex => {
  const coastalEdges = edges.filter((edge) => edge.adjacentHexIds.length === 1);
  const edgeIdsByVertex = new Map<VertexId, EdgeId[]>();
  for (const edge of coastalEdges) {
    for (const id of edge.vertexIds) {
      const incident = edgeIdsByVertex.get(id) ?? [];
      incident.push(edge.id);
      edgeIdsByVertex.set(id, incident);
    }
  }
  return {
    edges: coastalEdges,
    edgeById: new Map(coastalEdges.map((edge) => [edge.id, edge])),
    edgeIdsByVertex,
  };
};

const firstBoundaryEdge = (
  start: TopologyVertex,
  vertices: ReadonlyArray<TopologyVertex>,
  boundary: BoundaryIndex,
): TopologyEdge | undefined => {
  const coordinateById = new Map(vertices.map((vertex) => [vertex.id, vertex]));
  return (boundary.edgeIdsByVertex.get(start.id) ?? [])
    .map((id) => boundary.edgeById.get(id)!)
    .sort((left, right) =>
      compareCoordinates(
        coordinateById.get(otherVertex(left, start.id))!,
        coordinateById.get(otherVertex(right, start.id))!,
      ),
    )[0];
};

const traceBoundary = (
  start: VertexId,
  first: TopologyEdge,
  boundary: BoundaryIndex,
): ReadonlyArray<EdgeId> => {
  const ring: EdgeId[] = [];
  let currentVertex = start;
  let currentEdge = first;
  for (;;) {
    ring.push(currentEdge.id);
    const nextVertex = otherVertex(currentEdge, currentVertex);
    if (nextVertex === start) return ring;
    const nextEdgeId = (boundary.edgeIdsByVertex.get(nextVertex) ?? []).find(
      (id) => id !== currentEdge.id,
    );
    const nextEdge = nextEdgeId === undefined ? undefined : boundary.edgeById.get(nextEdgeId);
    if (nextEdge === undefined || ring.length > boundary.edges.length) {
      throw new Error("The standard board coastal ring is invalid.");
    }
    currentVertex = nextVertex;
    currentEdge = nextEdge;
  }
};

const walkCoastalRing = (
  vertices: ReadonlyArray<TopologyVertex>,
  edges: ReadonlyArray<TopologyEdge>,
): ReadonlyArray<EdgeId> => {
  const boundary = indexBoundary(edges);
  const start = vertices
    .filter((vertex) => boundary.edgeIdsByVertex.has(vertex.id))
    .sort(compareCoordinates)[0];
  if (start === undefined) {
    throw new Error("The standard board must have a coastal vertex.");
  }
  const first = firstBoundaryEdge(start, vertices, boundary);
  if (first === undefined) {
    throw new Error("The standard board must have a coastal edge.");
  }
  return traceBoundary(start.id, first, boundary);
};

export const generateStandardTopology = (): StandardTopology => {
  const coordinates = axialCoordinates();
  const available = new Set(coordinates.map(axialKey));
  const vertices = new Map<VertexId, MutableVertex>();
  const edges = new Map<EdgeId, MutableEdge>();
  const hexes = coordinates.map((coordinate) => addHex(coordinate, available, vertices, edges));
  const frozenVertices = freezeVertices(vertices);
  const frozenEdges = freezeEdges(edges);
  return {
    schema: "catanarchy.standard-topology.v1",
    hexes,
    vertices: frozenVertices,
    edges: frozenEdges,
    coastalRing: walkCoastalRing(frozenVertices, frozenEdges),
  };
};

export const STANDARD_TOPOLOGY = generateStandardTopology();
