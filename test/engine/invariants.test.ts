import { checkInvariants, createGame } from "@catanarchy/engine";
import type { GameConfig, GameState } from "@catanarchy/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "invariants",
  seed: 11,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
  ],
};

const initialState = (): GameState => Effect.runSync(createGame(config)).state;

describe("state invariants", () => {
  it("reports occupancy and distance violations", () => {
    const state = initialState();
    const first = state.topology.vertices[0]!;
    const adjacent = first.adjacentVertexIds[0]!;
    const edge = state.topology.edges[0]!;
    const broken: GameState = {
      ...state,
      occupancy: {
        buildings: [
          { vertexId: first.id, playerId: "red", kind: "settlement" },
          { vertexId: first.id, playerId: "blue", kind: "settlement" },
          { vertexId: adjacent, playerId: "white", kind: "settlement" },
          { vertexId: "v:99:99", playerId: "red", kind: "settlement" },
        ],
        roads: [
          { edgeId: edge.id, playerId: "red" },
          { edgeId: edge.id, playerId: "blue" },
          { edgeId: "e:v:90:90|v:91:91", playerId: "white" },
        ],
      },
    };

    expect(checkInvariants(broken)).toEqual(
      expect.arrayContaining([
        "duplicate-building",
        "duplicate-road",
        "unknown-building",
        "unknown-road",
        "settlement-distance",
      ]),
    );
  });

  it("reports resource, supply, and phase violations", () => {
    const state = initialState();
    const building = {
      vertexId: state.topology.vertices[0]!.id,
      playerId: "red",
      kind: "settlement" as const,
    };
    const road = { edgeId: state.topology.edges[0]!.id, playerId: "red" };
    const broken: GameState = {
      ...state,
      bank: { ...state.bank, ore: -1 },
      occupancy: {
        buildings: Array.from({ length: 6 }, () => building),
        roads: Array.from({ length: 16 }, () => road),
      },
      phase: { tag: "setup.settlement", direction: "forward", playerIndex: 99 },
    };
    const violations = checkInvariants(broken);

    expect(violations).toEqual(
      expect.arrayContaining([
        "invalid-resource-count",
        "resource-conservation",
        "building-supply:red",
        "road-supply:red",
        "active-player",
      ]),
    );
  });

  it("checks each resource supply independently", () => {
    const state = initialState();
    const broken: GameState = {
      ...state,
      bank: { ...state.bank, lumber: 18, brick: 20 },
    };

    expect(checkInvariants(broken)).toContain("resource-conservation");
  });

  it("checks settlement and city piece limits separately", () => {
    const state = initialState();
    const buildings = state.topology.vertices.slice(0, 9).map((vertex, index) => ({
      vertexId: vertex.id,
      playerId: "red",
      kind: index < 5 ? ("settlement" as const) : ("city" as const),
    }));
    const validSupply: GameState = { ...state, occupancy: { buildings, roads: [] } };
    const extraCity: GameState = {
      ...validSupply,
      occupancy: {
        ...validSupply.occupancy,
        buildings: [
          ...validSupply.occupancy.buildings,
          {
            vertexId: state.topology.vertices[9]!.id,
            playerId: "red",
            kind: "city",
          },
        ],
      },
    };

    expect(checkInvariants(validSupply)).not.toContain("building-supply:red");
    expect(checkInvariants(extraCity)).toContain("building-supply:red");
  });

  it("checks development-card conservation and purchase turns", () => {
    const state = initialState();
    const broken: GameState = {
      ...state,
      developmentDeck: state.developmentDeck.slice(2),
      players: state.players.map((player) =>
        player.id === "red"
          ? {
              ...player,
              developmentCards: [{ card: state.developmentDeck[0]!, purchasedTurn: 0 }],
            }
          : player,
      ),
    };

    expect(checkInvariants(broken)).toEqual(
      expect.arrayContaining(["development-card-turn:red", "development-card-conservation"]),
    );
  });

  it("reports a setup road without its player anchor", () => {
    const state = initialState();
    const broken: GameState = {
      ...state,
      phase: {
        tag: "setup.road",
        direction: "forward",
        playerIndex: 0,
        settlementId: state.topology.vertices[0]!.id,
      },
    };

    expect(checkInvariants(broken)).toContain("road-anchor");
  });
});
