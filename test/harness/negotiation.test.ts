import { createGame, handleCommand, legalActions } from "@catanarchy/engine";
import {
  applyNegotiationAction,
  closeNegotiationWindow,
  openNegotiationWindow,
  projectNegotiation,
} from "@catanarchy/harness";
import type {
  GameConfig,
  GameState,
  NegotiationAction,
  PlayerColor,
  ResourceCounts,
} from "@catanarchy/protocol";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";

const COLORS: ReadonlyArray<PlayerColor> = ["red", "blue", "white", "orange"];
const EMPTY: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "negotiation",
  seed: 42,
  players: COLORS.map((color) => ({ id: color, name: color, color })),
};

const actionState = (): GameState => {
  let state = Effect.runSync(createGame(config)).state;
  while (state.phase.tag !== "turn.roll") {
    state = Effect.runSync(handleCommand(state, legalActions(state)[0]!.command)).state;
  }
  const players = state.players.map((player) => ({
    ...player,
    resources:
      player.id === "red"
        ? { ...EMPTY, lumber: 3, wool: 1 }
        : player.id === "blue"
          ? { ...EMPTY, brick: 3, grain: 1 }
          : EMPTY,
  }));
  return {
    ...state,
    players,
    bank: { lumber: 16, brick: 16, wool: 18, grain: 18, ore: 19 },
    phase: {
      tag: "turn.action",
      playerIndex: 0,
      turn: 1,
      dice: [3, 4],
      developmentCardPlayed: false,
    },
  };
};

const apply = async (
  state: GameState,
  session: Awaited<ReturnType<typeof open>>,
  round: number,
  playerId: string,
  action: NegotiationAction,
) => Effect.runPromise(applyNegotiationAction(state, session, round, playerId, action));

const open = async (state: GameState) =>
  Effect.runPromise(
    openNegotiationWindow(state, { maxRounds: 3, maxMessageLength: 100, maxOpenOffers: 4 }),
  );

describe("negotiation protocol", () => {
  it("records a multi-round message, offer, counteroffer, and accepted atomic trade", async () => {
    let state = actionState();
    let session = await open(state);
    ({ session } = await apply(state, session, 1, "red", {
      type: "send-message",
      scope: { type: "public" },
      text: "I need brick and can trade lumber.",
    }));
    ({ session } = await apply(state, session, 1, "blue", {
      type: "send-message",
      scope: { type: "direct", playerId: "red" },
      text: "I can trade, but I want two lumber.",
    }));
    ({ session } = await apply(state, session, 2, "red", {
      type: "make-offer",
      targetPlayerId: "blue",
      scope: { type: "direct", playerId: "blue" },
      give: { ...EMPTY, lumber: 1 },
      receive: { ...EMPTY, brick: 1 },
    }));
    const firstOffer = session.offers[0]!;
    ({ session } = await apply(state, session, 2, "blue", {
      type: "counter-offer",
      offerId: firstOffer.id,
      scope: { type: "direct", playerId: "red" },
      give: { ...EMPTY, brick: 2 },
      receive: { ...EMPTY, lumber: 1 },
    }));
    const counter = session.offers[1]!;
    const accepted = await apply(state, session, 3, "red", {
      type: "accept-offer",
      offerId: counter.id,
    });
    state = accepted.state;
    session = accepted.session;

    expect(session.offers.map(({ status }) => status)).toEqual(["countered", "accepted"]);
    expect(state.sequence).toBe(actionState().sequence + 1);
    expect(accepted.gameEvents[0]?.event.type).toBe("domestic-trade.completed");
    expect(state.players.find(({ id }) => id === "red")?.resources).toEqual({
      ...EMPTY,
      lumber: 2,
      brick: 2,
      wool: 1,
    });
    expect(state.players.find(({ id }) => id === "blue")?.resources).toEqual({
      ...EMPTY,
      lumber: 1,
      brick: 1,
      grain: 1,
    });
  });

  it("projects public and directed records without leaking private text or bundles", async () => {
    const state = actionState();
    let session = await open(state);
    ({ session } = await apply(state, session, 1, "red", {
      type: "send-message",
      scope: { type: "public" },
      text: "Public argument",
    }));
    ({ session } = await apply(state, session, 1, "blue", {
      type: "send-message",
      scope: { type: "direct", playerId: "red" },
      text: "Secret blue message",
    }));
    ({ session } = await apply(state, session, 2, "red", {
      type: "make-offer",
      targetPlayerId: "blue",
      scope: { type: "direct", playerId: "blue" },
      give: { ...EMPTY, lumber: 1 },
      receive: { ...EMPTY, brick: 1 },
    }));
    ({ session } = await apply(state, session, 2, "red", {
      type: "make-offer",
      targetPlayerId: "white",
      scope: { type: "public" },
      give: { ...EMPTY, wool: 1 },
      receive: { ...EMPTY, grain: 1 },
    }));
    ({ session } = await apply(state, session, 2, "red", {
      type: "record-promise",
      beneficiaryPlayerId: "blue",
      scope: { type: "direct", playerId: "blue" },
      text: "I will avoid your route next turn.",
      relatedOfferId: session.offers[0]!.id,
    }));
    const promise = session.promises[0]!;
    ({ session } = await apply(state, session, 3, "blue", {
      type: "record-promise-evidence",
      promiseId: promise.id,
      gameSequence: state.sequence,
      text: "The current board is the evidence point.",
    }));

    const publicView = projectNegotiation(session);
    const redView = projectNegotiation(session, { type: "player", playerId: "red" });
    const whiteView = projectNegotiation(session, { type: "player", playerId: "white" });
    const publicJson = JSON.stringify(publicView);
    const redJson = JSON.stringify(redView);
    const whiteJson = JSON.stringify(whiteView);

    expect(session.offers[1]?.id).toMatch(/:offer:public:1$/);
    expect(publicView.events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: publicView.events.length }, (_value, sequence) => sequence),
    );
    expect(publicView.sequence).toBe(publicView.events.length);
    expect(whiteView.sequence).toBe(whiteView.events.length);
    expect(redView.events.length).toBeGreaterThan(whiteView.events.length);
    expect(publicJson).toContain("Public argument");
    expect(publicJson).not.toContain("Secret blue message");
    expect(publicJson).not.toContain("avoid your route");
    expect(redJson).toContain("Secret blue message");
    expect(redJson).toContain("avoid your route");
    expect(redJson).toContain("evidence point");
    expect(whiteJson).not.toContain("Secret blue message");
    expect(whiteJson).not.toContain('"brick":1');
  });

  it("carries promises into later turn windows for evidence", async () => {
    const firstState = actionState();
    let first = await open(firstState);
    ({ session: first } = await apply(firstState, first, 1, "red", {
      type: "record-promise",
      beneficiaryPlayerId: "blue",
      scope: { type: "direct", playerId: "blue" },
      text: "I will not block your route.",
      relatedOfferId: null,
    }));
    first = closeNegotiationWindow(firstState, first, "round-limit");
    const laterState: GameState = {
      ...firstState,
      phase: {
        tag: "turn.action",
        playerIndex: 1,
        turn: 2,
        dice: [4, 4],
        developmentCardPlayed: false,
      },
    };
    let later = await Effect.runPromise(
      openNegotiationWindow(
        laterState,
        { maxRounds: 3, maxMessageLength: 100, maxOpenOffers: 4 },
        first.sequence + 1,
        first,
      ),
    );
    ({ session: later } = await apply(laterState, later, 1, "blue", {
      type: "record-promise-evidence",
      promiseId: first.promises[0]!.id,
      gameSequence: laterState.sequence,
      text: "The later board position is evidence.",
    }));

    expect(later.promises).toEqual(first.promises);
    expect(later.evidence[0]?.promiseId).toBe(first.promises[0]?.id);
    expect(projectNegotiation(later, { type: "player", playerId: "blue" }).events).toHaveLength(
      later.events.length,
    );
  });

  it("expires conflicting offers after one accepted trade", async () => {
    let state = actionState();
    let session = await open(state);
    for (const amount of [1, 2]) {
      ({ session } = await apply(state, session, 1, "red", {
        type: "make-offer",
        targetPlayerId: "blue",
        scope: { type: "public" },
        give: { ...EMPTY, lumber: amount },
        receive: { ...EMPTY, brick: 1 },
      }));
    }
    const accepted = await apply(state, session, 2, "blue", {
      type: "accept-offer",
      offerId: session.offers[0]!.id,
    });
    state = accepted.state;
    session = accepted.session;

    expect(session.offers.map(({ status }) => status)).toEqual(["accepted", "expired"]);
    expect(
      session.events.some(
        ({ event }) => event.type === "trade.offer-closed" && event.status === "expired",
      ),
    ).toBe(true);
    expect(state.sequence).toBeGreaterThan(actionState().sequence);
  });

  it("lets the target reject and the proposer withdraw open offers", async () => {
    const state = actionState();
    let session = await open(state);
    for (const amount of [1, 2]) {
      ({ session } = await apply(state, session, 1, "red", {
        type: "make-offer",
        targetPlayerId: "blue",
        scope: { type: "public" },
        give: { ...EMPTY, lumber: amount },
        receive: { ...EMPTY, brick: 1 },
      }));
    }
    ({ session } = await apply(state, session, 1, "blue", {
      type: "reject-offer",
      offerId: session.offers[0]!.id,
    }));
    ({ session } = await apply(state, session, 1, "red", {
      type: "withdraw-offer",
      offerId: session.offers[1]!.id,
    }));

    expect(session.offers.map(({ status }) => status)).toEqual(["rejected", "withdrawn"]);
  });

  it("records impossible settlement and rejects a stale window", async () => {
    const state = actionState();
    let session = await open(state);
    ({ session } = await apply(state, session, 1, "red", {
      type: "make-offer",
      targetPlayerId: "blue",
      scope: { type: "direct", playerId: "blue" },
      give: { ...EMPTY, lumber: 1 },
      receive: { ...EMPTY, ore: 1 },
    }));
    const impossible = await apply(state, session, 1, "blue", {
      type: "accept-offer",
      offerId: session.offers[0]!.id,
    });
    expect(impossible.state).toEqual(state);
    expect(impossible.session.offers[0]?.status).toBe("failed");
    expect(impossible.session.events.at(-1)?.event).toMatchObject({
      type: "trade.offer-failed",
      reason: "invalid",
    });

    session = await open(state);
    ({ session } = await apply(state, session, 1, "red", {
      type: "make-offer",
      targetPlayerId: "blue",
      scope: { type: "public" },
      give: { ...EMPTY, lumber: 1 },
      receive: { ...EMPTY, brick: 1 },
    }));
    const changedState = { ...state, sequence: state.sequence + 1 };
    const stale = await Effect.runPromise(
      Effect.either(
        applyNegotiationAction(changedState, session, 1, "blue", {
          type: "accept-offer",
          offerId: session.offers[0]!.id,
        }),
      ),
    );
    expect(Either.isLeft(stale) && stale.left.code).toBe("invalid-window");

    const endedState: GameState = {
      ...state,
      phase: { tag: "turn.roll", playerIndex: 1, turn: 2, developmentCardPlayed: false },
    };
    const afterTurn = await Effect.runPromise(
      Effect.either(
        applyNegotiationAction(endedState, session, 1, "red", {
          type: "send-message",
          scope: { type: "public" },
          text: "Too late",
        }),
      ),
    );
    expect(Either.isLeft(afterTurn) && afterTurn.left.code).toBe("invalid-window");
  });

  it("enforces actor, scope, offer, text, and policy limits", async () => {
    const state = actionState();
    const session = await open(state);
    const invalidActions: Array<[string, string, NegotiationAction]> = [
      [
        "blue",
        "wrong-player",
        {
          type: "make-offer",
          targetPlayerId: "red",
          scope: { type: "public" },
          give: { ...EMPTY, brick: 1 },
          receive: { ...EMPTY, lumber: 1 },
        },
      ],
      [
        "red",
        "invalid-scope",
        {
          type: "send-message",
          scope: { type: "direct", playerId: "red" },
          text: "self",
        },
      ],
      [
        "red",
        "invalid-action",
        { type: "send-message", scope: { type: "public" }, text: "x".repeat(101) },
      ],
      [
        "red",
        "invalid-offer",
        {
          type: "make-offer",
          targetPlayerId: "blue",
          scope: { type: "public" },
          give: EMPTY,
          receive: { ...EMPTY, brick: 1 },
        },
      ],
    ];

    for (const [playerId, code, action] of invalidActions) {
      const result = await Effect.runPromise(
        Effect.either(applyNegotiationAction(state, session, 1, playerId, action)),
      );
      expect(Either.isLeft(result) && result.left.code).toBe(code);
    }
    const invalidPolicy = await Effect.runPromise(
      Effect.either(
        openNegotiationWindow(state, {
          maxRounds: 0,
          maxMessageLength: 100,
          maxOpenOffers: 1,
        }),
      ),
    );
    expect(Either.isLeft(invalidPolicy) && invalidPolicy.left.code).toBe("invalid-policy");
  });

  it("rejects unauthorized replies and expires offers when a window closes", async () => {
    const state = actionState();
    let session = await open(state);
    ({ session } = await apply(state, session, 1, "red", {
      type: "make-offer",
      targetPlayerId: "blue",
      scope: { type: "public" },
      give: { ...EMPTY, lumber: 1 },
      receive: { ...EMPTY, brick: 1 },
    }));
    const offerId = session.offers[0]!.id;
    const unauthorized = await Effect.runPromise(
      Effect.either(
        applyNegotiationAction(state, session, 1, "white", {
          type: "accept-offer",
          offerId,
        }),
      ),
    );
    expect(Either.isLeft(unauthorized) && unauthorized.left.code).toBe("invalid-offer");

    const closed = closeNegotiationWindow(state, session, "round-limit");
    expect(closed.closed).toBe(true);
    expect(closed.offers[0]?.status).toBe("expired");
    const afterClose = await Effect.runPromise(
      Effect.either(
        applyNegotiationAction(state, closed, 1, "blue", {
          type: "accept-offer",
          offerId,
        }),
      ),
    );
    expect(Either.isLeft(afterClose) && afterClose.left.code).toBe("invalid-window");
  });
});
