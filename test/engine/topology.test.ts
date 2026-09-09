import { generateStandardTopology, STANDARD_TOPOLOGY } from "@catanarchy/engine";
import type { TopologyEdge, TopologyHex, TopologyVertex } from "@catanarchy/protocol";
import { describe, expect, it } from "vitest";

const expectHexRelations = (hex: TopologyHex, edgeById: ReadonlyMap<string, TopologyEdge>) => {
  expect(new Set(hex.vertexIds).size).toBe(6);
  expect(new Set(hex.edgeIds).size).toBe(6);
  for (const edgeId of hex.edgeIds) expect(edgeById.get(edgeId)?.adjacentHexIds).toContain(hex.id);
};

const expectVertexRelations = (
  vertex: TopologyVertex,
  vertexById: ReadonlyMap<string, TopologyVertex>,
  edgeById: ReadonlyMap<string, TopologyEdge>,
) => {
  for (const neighborId of vertex.adjacentVertexIds) {
    expect(vertexById.get(neighborId)?.adjacentVertexIds).toContain(vertex.id);
  }
  for (const edgeId of vertex.edgeIds) expect(edgeById.get(edgeId)?.vertexIds).toContain(vertex.id);
};

describe("standard topology", () => {
  it("has the exact regular-board counts", () => {
    const topology = STANDARD_TOPOLOGY;
    const coastal = topology.edges.filter((edge) => edge.adjacentHexIds.length === 1);
    const internal = topology.edges.filter((edge) => edge.adjacentHexIds.length === 2);
    const degrees = topology.vertices.map((vertex) => vertex.adjacentVertexIds.length);
    const hexIncidence = topology.vertices.map((vertex) => vertex.adjacentHexIds.length);

    expect(topology.hexes).toHaveLength(19);
    expect(topology.vertices).toHaveLength(54);
    expect(topology.edges).toHaveLength(72);
    expect(coastal).toHaveLength(30);
    expect(internal).toHaveLength(42);
    expect(degrees.filter((degree) => degree === 2)).toHaveLength(18);
    expect(degrees.filter((degree) => degree === 3)).toHaveLength(36);
    expect(hexIncidence.filter((count) => count === 1)).toHaveLength(18);
    expect(hexIncidence.filter((count) => count === 2)).toHaveLength(12);
    expect(hexIncidence.filter((count) => count === 3)).toHaveLength(24);
    expect(topology.vertices.length - topology.edges.length + topology.hexes.length).toBe(1);
  });

  it("has symmetric and complete adjacency", () => {
    expect.hasAssertions();
    const vertexById = new Map(STANDARD_TOPOLOGY.vertices.map((vertex) => [vertex.id, vertex]));
    const edgeById = new Map(STANDARD_TOPOLOGY.edges.map((edge) => [edge.id, edge]));

    for (const hex of STANDARD_TOPOLOGY.hexes) expectHexRelations(hex, edgeById);
    for (const vertex of STANDARD_TOPOLOGY.vertices)
      expectVertexRelations(vertex, vertexById, edgeById);
  });

  it("forms one deterministic coastal ring", () => {
    expect(STANDARD_TOPOLOGY.coastalRing).toHaveLength(30);
    expect(new Set(STANDARD_TOPOLOGY.coastalRing).size).toBe(30);
    expect(generateStandardTopology()).toEqual(STANDARD_TOPOLOGY);

    const edgeById = new Map(STANDARD_TOPOLOGY.edges.map((edge) => [edge.id, edge]));
    for (let index = 0; index < STANDARD_TOPOLOGY.coastalRing.length; index += 1) {
      const current = edgeById.get(STANDARD_TOPOLOGY.coastalRing[index]!)!;
      const next = edgeById.get(STANDARD_TOPOLOGY.coastalRing[(index + 1) % 30]!)!;
      expect(current.vertexIds.some((id) => next.vertexIds.includes(id))).toBe(true);
    }
  });
});
