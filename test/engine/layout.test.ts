import { generateGameMaterials, STANDARD_TOPOLOGY } from "@catanarchy/engine";
import type { DevelopmentCard, HarborKind, NumberToken, Terrain } from "@catanarchy/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const counts = <T extends string | number>(values: ReadonlyArray<T>): Map<T, number> => {
  const result = new Map<T, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
};

const expectedTerrain = new Map<Terrain, number>([
  ["forest", 4],
  ["pasture", 4],
  ["field", 4],
  ["hill", 3],
  ["mountain", 3],
  ["desert", 1],
]);
const expectedNumbers = new Map<NumberToken, number>([
  [2, 1],
  [3, 2],
  [4, 2],
  [5, 2],
  [6, 2],
  [8, 2],
  [9, 2],
  [10, 2],
  [11, 2],
  [12, 1],
]);
const expectedHarbors = new Map<HarborKind, number>([
  ["generic", 4],
  ["lumber", 1],
  ["brick", 1],
  ["wool", 1],
  ["grain", 1],
  ["ore", 1],
]);
const expectedDeck = new Map<DevelopmentCard, number>([
  ["knight", 14],
  ["road-building", 2],
  ["year-of-plenty", 2],
  ["monopoly", 2],
  ["victory-point", 5],
]);

const verifyMaterials = (seed: number) => {
  const materials = generateGameMaterials(STANDARD_TOPOLOGY, seed);
  const terrain = new Map(materials.layout.terrain.map((item) => [item.hexId, item.terrain]));
  const coastal = new Set(STANDARD_TOPOLOGY.coastalRing);

  expect(counts(materials.layout.terrain.map(({ terrain: value }) => value))).toEqual(
    expectedTerrain,
  );
  expect(counts(materials.layout.numbers.map(({ number }) => number))).toEqual(expectedNumbers);
  expect(counts(materials.layout.harbors.map(({ kind }) => kind))).toEqual(expectedHarbors);
  expect(counts(materials.developmentDeck)).toEqual(expectedDeck);
  expect(materials.layout.terrain).toHaveLength(19);
  expect(materials.layout.numbers).toHaveLength(18);
  expect(materials.layout.harbors).toHaveLength(9);
  expect(new Set(materials.layout.harbors.map(({ edgeId }) => edgeId)).size).toBe(9);
  expect(materials.layout.harbors.every(({ edgeId }) => coastal.has(edgeId))).toBe(true);
  const edgeOrder = new Map(STANDARD_TOPOLOGY.edges.map((edge, index) => [edge.id, index]));
  const serializedHarborOrder = materials.layout.harbors.map(({ edgeId }) =>
    edgeOrder.get(edgeId)!,
  );
  expect(serializedHarborOrder).toEqual(
    [...serializedHarborOrder].sort((left, right) => left - right),
  );
  const harborIndexes = materials.layout.harbors
    .map(({ edgeId }) => STANDARD_TOPOLOGY.coastalRing.indexOf(edgeId))
    .sort((left, right) => left - right);
  const harborGaps = harborIndexes
    .map((index, position) => {
      const next = harborIndexes[(position + 1) % harborIndexes.length]!;
      return (
        (next - index + STANDARD_TOPOLOGY.coastalRing.length) % STANDARD_TOPOLOGY.coastalRing.length
      );
    })
    .sort((left, right) => left - right);
  expect(harborGaps).toEqual([3, 3, 3, 3, 3, 3, 4, 4, 4]);
  expect(terrain.get(materials.layout.robberHexId)).toBe("desert");
  expect(materials.layout.numbers.some(({ hexId }) => hexId === materials.layout.robberHexId)).toBe(
    false,
  );
  const numberByHex = new Map(materials.layout.numbers.map(({ hexId, number }) => [hexId, number]));
  const adjacentRedTokens = STANDARD_TOPOLOGY.hexes.some(
    (hex) =>
      (numberByHex.get(hex.id) === 6 || numberByHex.get(hex.id) === 8) &&
      hex.neighborHexIds.some((id) => numberByHex.get(id) === 6 || numberByHex.get(id) === 8),
  );
  expect(adjacentRedTokens).toBe(false);
};

describe("standard board layout", () => {
  it("is deterministic for a fixed seed", () => {
    expect(generateGameMaterials(STANDARD_TOPOLOGY, 42)).toEqual(
      generateGameMaterials(STANDARD_TOPOLOGY, 42),
    );
  });

  it("uses independent board and deck streams", () => {
    const materials = generateGameMaterials(STANDARD_TOPOLOGY, 42);
    expect(materials.boardRandom).not.toEqual(materials.developmentDeckRandom);
  });

  it("preserves every standard supply across generated seeds", () => {
    expect.hasAssertions();
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), verifyMaterials), {
      numRuns: 1_000,
    });
  });
});
