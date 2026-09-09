import { handleCommand } from "@catanarchy/engine";
import {
  decodeNegotiationAction,
  type GameEvent,
  type GameState,
  type NegotiationAction,
  type NegotiationEvent,
  type NegotiationEventPayload,
  type NegotiationPromise,
  type NegotiationScope,
  type NegotiationView,
  type PlayerId,
  type PromiseEvidence,
  type ResourceCounts,
  type TradeOffer,
  type TradeOfferStatus,
  type Viewer,
} from "@catanarchy/protocol";
import { Data, Effect, Either } from "effect";

const RESOURCE_KEYS = ["lumber", "brick", "wool", "grain", "ore"] as const;

export interface NegotiationPolicy {
  readonly maxRounds: number;
  readonly maxMessageLength: number;
  readonly maxOpenOffers: number;
}

export const DEFAULT_NEGOTIATION_POLICY: NegotiationPolicy = {
  maxRounds: 3,
  maxMessageLength: 500,
  maxOpenOffers: 8,
};

export interface NegotiationSession {
  readonly matchId: string;
  readonly windowId: string;
  readonly turn: number;
  readonly turnPlayerId: PlayerId;
  readonly gameSequence: number;
  readonly policy: NegotiationPolicy;
  readonly sequence: number;
  readonly events: ReadonlyArray<NegotiationEvent>;
  readonly offers: ReadonlyArray<TradeOffer>;
  readonly promises: ReadonlyArray<NegotiationPromise>;
  readonly evidence: ReadonlyArray<PromiseEvidence>;
  readonly closed: boolean;
}

export interface NegotiationActionResult {
  readonly state: GameState;
  readonly session: NegotiationSession;
  readonly gameEvents: ReadonlyArray<GameEvent>;
}

export class NegotiationViolation extends Data.TaggedError("NegotiationViolation")<{
  readonly code:
    | "invalid-action"
    | "invalid-offer"
    | "invalid-policy"
    | "invalid-promise"
    | "invalid-scope"
    | "invalid-window"
    | "wrong-player";
  readonly message: string;
}> {}

const fail = (
  code: NegotiationViolation["code"],
  message: string,
): Effect.Effect<never, NegotiationViolation> =>
  Effect.fail(new NegotiationViolation({ code, message }));

const validPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const validatePolicy = (policy: NegotiationPolicy): Effect.Effect<void, NegotiationViolation> =>
  validPositiveInteger(policy.maxRounds) &&
  validPositiveInteger(policy.maxMessageLength) &&
  validPositiveInteger(policy.maxOpenOffers)
    ? Effect.void
    : fail("invalid-policy", "Negotiation policy limits must be positive integers.");

const appendEvent = (
  session: NegotiationSession,
  gameSequence: number,
  event: NegotiationEventPayload,
): NegotiationSession => {
  const envelope: NegotiationEvent = {
    schema: "catanarchy.negotiation-event.v1",
    matchId: session.matchId,
    sequence: session.sequence + 1,
    gameSequence,
    event,
  };
  return { ...session, sequence: envelope.sequence, events: [...session.events, envelope] };
};

const validateHistory = (
  state: GameState,
  history: NegotiationSession | undefined,
  initialSequence: number,
): Effect.Effect<void, NegotiationViolation> => {
  if (history === undefined) return Effect.void;
  if (!history.closed) return fail("invalid-window", "The prior negotiation window is open.");
  if (history.matchId !== state.matchId) {
    return fail("invalid-window", "The negotiation history belongs to a different match.");
  }
  if (!("turn" in state.phase) || history.turn >= state.phase.turn) {
    return fail("invalid-window", "A negotiation history must precede the new turn.");
  }
  return initialSequence === history.sequence + 1
    ? Effect.void
    : fail("invalid-window", "The negotiation history sequence is not contiguous.");
};

interface InheritedNegotiationHistory {
  readonly events: ReadonlyArray<NegotiationEvent>;
  readonly offers: ReadonlyArray<TradeOffer>;
  readonly promises: ReadonlyArray<NegotiationPromise>;
  readonly evidence: ReadonlyArray<PromiseEvidence>;
}

const inheritHistory = (history: NegotiationSession | undefined): InheritedNegotiationHistory =>
  history === undefined
    ? { events: [], offers: [], promises: [], evidence: [] }
    : {
        events: history.events,
        offers: history.offers,
        promises: history.promises,
        evidence: history.evidence,
      };

export const openNegotiationWindow = (
  state: GameState,
  policy: NegotiationPolicy = DEFAULT_NEGOTIATION_POLICY,
  initialSequence = 0,
  history?: NegotiationSession,
): Effect.Effect<NegotiationSession, NegotiationViolation> =>
  Effect.gen(function* () {
    yield* validatePolicy(policy);
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      return yield* fail("invalid-window", "The initial negotiation sequence is invalid.");
    }
    yield* validateHistory(state, history, initialSequence);
    if (state.phase.tag !== "turn.action") {
      return yield* fail("invalid-window", "Negotiation can start only in the action phase.");
    }
    const turnPlayerId = state.config.players[state.phase.playerIndex]?.id;
    if (turnPlayerId === undefined) {
      return yield* fail("invalid-window", "The turn player does not exist.");
    }
    const inherited = inheritHistory(history);
    const windowId = `${state.matchId}:window:${state.phase.turn}`;
    const opened: NegotiationEvent = {
      schema: "catanarchy.negotiation-event.v1",
      matchId: state.matchId,
      sequence: initialSequence,
      gameSequence: state.sequence,
      event: {
        type: "negotiation.window-opened",
        windowId,
        turn: state.phase.turn,
        turnPlayerId,
        maxRounds: policy.maxRounds,
      },
    };
    return {
      matchId: state.matchId,
      windowId,
      turn: state.phase.turn,
      turnPlayerId,
      gameSequence: state.sequence,
      policy,
      sequence: initialSequence,
      events: [...inherited.events, opened],
      offers: inherited.offers,
      promises: inherited.promises,
      evidence: inherited.evidence,
      closed: false,
    };
  });

const playerExists = (state: GameState, playerId: PlayerId): boolean =>
  state.players.some(({ id }) => id === playerId);

const validText = (text: string, limit: number): boolean =>
  text.trim().length > 0 && Array.from(text).length <= limit;

const validateScope = (
  state: GameState,
  actorPlayerId: PlayerId,
  scope: NegotiationScope,
): Effect.Effect<void, NegotiationViolation> => {
  if (scope.type === "public") return Effect.void;
  return playerExists(state, scope.playerId) && scope.playerId !== actorPlayerId
    ? Effect.void
    : fail("invalid-scope", "A directed record needs one other configured player.");
};

const resourceTotal = (resources: ResourceCounts): number =>
  RESOURCE_KEYS.reduce((total, resource) => total + resources[resource], 0);

const validBundle = (resources: ResourceCounts): boolean =>
  RESOURCE_KEYS.every(
    (resource) => Number.isSafeInteger(resources[resource]) && resources[resource] >= 0,
  ) && resourceTotal(resources) > 0;

const validOfferBundles = (give: ResourceCounts, receive: ResourceCounts): boolean =>
  validBundle(give) &&
  validBundle(receive) &&
  RESOURCE_KEYS.every((resource) => give[resource] === 0 || receive[resource] === 0);

const hasResources = (available: ResourceCounts, needed: ResourceCounts): boolean =>
  RESOURCE_KEYS.every((resource) => available[resource] >= needed[resource]);

const updateOfferStatus = (
  offers: ReadonlyArray<TradeOffer>,
  offerId: string,
  status: TradeOfferStatus,
): ReadonlyArray<TradeOffer> =>
  offers.map((offer) => (offer.id === offerId ? { ...offer, status } : offer));

const findOpenOffer = (session: NegotiationSession, offerId: string): TradeOffer | undefined =>
  session.offers.find((offer) => offer.id === offerId && offer.status === "open");

const validateOfferScope = (
  scope: NegotiationScope,
  targetPlayerId: PlayerId,
): Effect.Effect<void, NegotiationViolation> =>
  scope.type === "direct" && scope.playerId !== targetPlayerId
    ? fail("invalid-scope", "A directed offer must be directed to its target.")
    : Effect.void;

const createOffer = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  proposerPlayerId: PlayerId,
  targetPlayerId: PlayerId,
  scope: NegotiationScope,
  give: ResourceCounts,
  receive: ResourceCounts,
  parentOfferId: string | null,
): Effect.Effect<NegotiationSession, NegotiationViolation> =>
  Effect.gen(function* () {
    yield* validateScope(state, proposerPlayerId, scope);
    yield* validateOfferScope(scope, targetPlayerId);
    if (!validOfferBundles(give, receive)) {
      return yield* fail(
        "invalid-offer",
        "Both offer bundles must contain cards and use disjoint resource types.",
      );
    }
    const proposer = state.players.find(({ id }) => id === proposerPlayerId);
    if (proposer === undefined || !hasResources(proposer.resources, give)) {
      return yield* fail("invalid-offer", "The proposer does not hold the offered resources.");
    }
    const openOfferCount = session.offers.filter(({ status }) => status === "open").length;
    if (openOfferCount >= session.policy.maxOpenOffers) {
      return yield* fail("invalid-offer", "The negotiation window has too many open offers.");
    }
    const offer: TradeOffer = {
      id: `${session.windowId}:offer:${session.sequence + 1}`,
      parentOfferId,
      round,
      gameSequence: state.sequence,
      proposerPlayerId,
      targetPlayerId,
      scope,
      give,
      receive,
      status: "open",
    };
    const withOffer = { ...session, offers: [...session.offers, offer] };
    return appendEvent(withOffer, state.sequence, { type: "trade.offer-created", offer });
  });

const closeOffer = (
  state: GameState,
  session: NegotiationSession,
  offer: TradeOffer,
  playerId: PlayerId | null,
  status: "rejected" | "withdrawn" | "countered" | "expired",
): NegotiationSession => {
  const updated = {
    ...session,
    offers: updateOfferStatus(session.offers, offer.id, status),
  };
  return appendEvent(updated, state.sequence, {
    type: "trade.offer-closed",
    offerId: offer.id,
    playerId,
    status,
  });
};

const applyMessage = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
  action: Extract<NegotiationAction, { readonly type: "send-message" }>,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> =>
  Effect.gen(function* () {
    yield* validateScope(state, playerId, action.scope);
    if (!validText(action.text, session.policy.maxMessageLength)) {
      return yield* fail("invalid-action", "The message is empty or exceeds the policy limit.");
    }
    return {
      state,
      gameEvents: [],
      session: appendEvent(session, state.sequence, {
        type: "negotiation.message-sent",
        round,
        playerId,
        scope: action.scope,
        text: action.text,
      }),
    };
  });

const makeOffer = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
  action: Extract<NegotiationAction, { readonly type: "make-offer" }>,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> =>
  Effect.gen(function* () {
    if (playerId !== session.turnPlayerId) {
      return yield* fail("wrong-player", "Only the turn player can make a new offer.");
    }
    if (action.targetPlayerId === playerId || !playerExists(state, action.targetPlayerId)) {
      return yield* fail("invalid-offer", "An offer needs one other configured player.");
    }
    const next = yield* createOffer(
      state,
      session,
      round,
      playerId,
      action.targetPlayerId,
      action.scope,
      action.give,
      action.receive,
      null,
    );
    return { state, session: next, gameEvents: [] };
  });

const counterOffer = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
  action: Extract<NegotiationAction, { readonly type: "counter-offer" }>,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> =>
  Effect.gen(function* () {
    const parent = findOpenOffer(session, action.offerId);
    if (parent === undefined || parent.targetPlayerId !== playerId) {
      return yield* fail("invalid-offer", "Only the target can counter an open offer.");
    }
    const closed = closeOffer(state, session, parent, playerId, "countered");
    const next = yield* createOffer(
      state,
      closed,
      round,
      playerId,
      parent.proposerPlayerId,
      action.scope,
      action.give,
      action.receive,
      parent.id,
    );
    return { state, session: next, gameEvents: [] };
  });

const normalizeAcceptedOffer = (
  session: NegotiationSession,
  offer: TradeOffer,
): {
  readonly partnerPlayerId: PlayerId;
  readonly give: ResourceCounts;
  readonly receive: ResourceCounts;
} =>
  offer.proposerPlayerId === session.turnPlayerId
    ? { partnerPlayerId: offer.targetPlayerId, give: offer.give, receive: offer.receive }
    : { partnerPlayerId: offer.proposerPlayerId, give: offer.receive, receive: offer.give };

const failAcceptedOffer = (
  state: GameState,
  session: NegotiationSession,
  offer: TradeOffer,
  playerId: PlayerId,
  reason: "invalid" | "stale",
): NegotiationActionResult => {
  const withStatus = { ...session, offers: updateOfferStatus(session.offers, offer.id, "failed") };
  return {
    state,
    gameEvents: [],
    session: appendEvent(withStatus, state.sequence, {
      type: "trade.offer-failed",
      offerId: offer.id,
      playerId,
      reason,
    }),
  };
};

const expireOpenOffers = (state: GameState, session: NegotiationSession): NegotiationSession =>
  session.offers
    .filter(({ status }) => status === "open")
    .reduce((current, offer) => closeOffer(state, current, offer, null, "expired"), session);

const acceptOffer = (
  state: GameState,
  session: NegotiationSession,
  playerId: PlayerId,
  offerId: string,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> =>
  Effect.gen(function* () {
    const offer = findOpenOffer(session, offerId);
    if (offer === undefined || offer.targetPlayerId !== playerId) {
      return yield* fail("invalid-offer", "Only the target can accept an open offer.");
    }
    if (offer.gameSequence !== state.sequence) {
      return failAcceptedOffer(state, session, offer, playerId, "stale");
    }
    const trade = normalizeAcceptedOffer(session, offer);
    const command = {
      schema: "catanarchy.command.v1" as const,
      matchId: state.matchId,
      commandId: `${session.windowId}:settle:${offer.id}`,
      playerId: session.turnPlayerId,
      expectedSequence: state.sequence,
      command: { type: "domestic-trade" as const, ...trade },
    };
    const settlement = yield* Effect.either(handleCommand(state, command));
    if (Either.isLeft(settlement)) {
      return failAcceptedOffer(state, session, offer, playerId, "invalid");
    }
    const firstEvent = settlement.right.events[0];
    const accepted = {
      ...session,
      offers: updateOfferStatus(session.offers, offer.id, "accepted"),
    };
    const recorded = appendEvent(accepted, settlement.right.state.sequence, {
      type: "trade.offer-accepted",
      offerId: offer.id,
      playerId,
      gameEventSequence: firstEvent.sequence,
    });
    return {
      state: settlement.right.state,
      gameEvents: settlement.right.events,
      session: expireOpenOffers(settlement.right.state, {
        ...recorded,
        gameSequence: settlement.right.state.sequence,
      }),
    };
  });

const rejectOrWithdraw = (
  state: GameState,
  session: NegotiationSession,
  playerId: PlayerId,
  offerId: string,
  status: "rejected" | "withdrawn",
): Effect.Effect<NegotiationActionResult, NegotiationViolation> => {
  const offer = findOpenOffer(session, offerId);
  const permitted =
    offer !== undefined &&
    (status === "rejected"
      ? offer.targetPlayerId === playerId
      : offer.proposerPlayerId === playerId);
  return permitted && offer !== undefined
    ? Effect.succeed({
        state,
        gameEvents: [],
        session: closeOffer(state, session, offer, playerId, status),
      })
    : fail(
        "invalid-offer",
        status === "rejected"
          ? "Only the target can reject an open offer."
          : "Only the proposer can withdraw an open offer.",
      );
};

const scopeIncludesPlayer = (
  scope: NegotiationScope,
  ownerPlayerId: PlayerId,
  playerId: PlayerId,
): boolean => scope.type === "public" || playerId === ownerPlayerId || playerId === scope.playerId;

const relatedOfferIsVisible = (
  session: NegotiationSession,
  offerId: string | null,
  playerId: PlayerId,
): boolean => {
  if (offerId === null) return true;
  const offer = session.offers.find(({ id }) => id === offerId);
  return (
    offer !== undefined &&
    (offer.scope.type === "public" ||
      playerId === offer.proposerPlayerId ||
      playerId === offer.targetPlayerId)
  );
};

const validPromiseFields = (
  state: GameState,
  session: NegotiationSession,
  playerId: PlayerId,
  action: Extract<NegotiationAction, { readonly type: "record-promise" }>,
): boolean =>
  playerExists(state, action.beneficiaryPlayerId) &&
  action.beneficiaryPlayerId !== playerId &&
  validText(action.text, session.policy.maxMessageLength) &&
  (action.scope.type === "public" || action.scope.playerId === action.beneficiaryPlayerId) &&
  relatedOfferIsVisible(session, action.relatedOfferId, playerId);

const recordPromise = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
  action: Extract<NegotiationAction, { readonly type: "record-promise" }>,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> =>
  Effect.gen(function* () {
    yield* validateScope(state, playerId, action.scope);
    if (!validPromiseFields(state, session, playerId, action)) {
      return yield* fail("invalid-promise", "The promise fields are invalid.");
    }
    const promise: NegotiationPromise = {
      id: `${session.windowId}:promise:${session.sequence + 1}`,
      round,
      playerId,
      beneficiaryPlayerId: action.beneficiaryPlayerId,
      scope: action.scope,
      text: action.text,
      relatedOfferId: action.relatedOfferId,
    };
    const withPromise = { ...session, promises: [...session.promises, promise] };
    return {
      state,
      gameEvents: [],
      session: appendEvent(withPromise, state.sequence, {
        type: "negotiation.promise-recorded",
        promise,
      }),
    };
  });

const validPromiseEvidence = (
  state: GameState,
  session: NegotiationSession,
  playerId: PlayerId,
  action: Extract<NegotiationAction, { readonly type: "record-promise-evidence" }>,
): boolean => {
  const promise = session.promises.find(({ id }) => id === action.promiseId);
  return (
    promise !== undefined &&
    scopeIncludesPlayer(promise.scope, promise.playerId, playerId) &&
    Number.isSafeInteger(action.gameSequence) &&
    action.gameSequence >= 0 &&
    action.gameSequence <= state.sequence &&
    validText(action.text, session.policy.maxMessageLength)
  );
};

const recordEvidence = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
  action: Extract<NegotiationAction, { readonly type: "record-promise-evidence" }>,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> =>
  Effect.gen(function* () {
    if (!validPromiseEvidence(state, session, playerId, action)) {
      return yield* fail("invalid-promise", "The promise evidence is invalid.");
    }
    const evidence: PromiseEvidence = {
      id: `${session.windowId}:evidence:${session.sequence + 1}`,
      round,
      playerId,
      promiseId: action.promiseId,
      gameSequence: action.gameSequence,
      text: action.text,
    };
    const withEvidence = { ...session, evidence: [...session.evidence, evidence] };
    return {
      state,
      gameEvents: [],
      session: appendEvent(withEvidence, state.sequence, {
        type: "negotiation.promise-evidence-recorded",
        evidence,
      }),
    };
  });

const applyCommunicationAction = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
  action: NegotiationAction,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> | undefined => {
  switch (action.type) {
    case "pass":
      return Effect.succeed({
        state,
        gameEvents: [],
        session: appendEvent(session, state.sequence, {
          type: "negotiation.player-passed",
          round,
          playerId,
        }),
      });
    case "send-message":
      return applyMessage(state, session, round, playerId, action);
    case "record-promise":
      return recordPromise(state, session, round, playerId, action);
    case "record-promise-evidence":
      return recordEvidence(state, session, round, playerId, action);
    default:
      return undefined;
  }
};

const applyOfferAction = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
  action: NegotiationAction,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> | undefined => {
  switch (action.type) {
    case "make-offer":
      return makeOffer(state, session, round, playerId, action);
    case "counter-offer":
      return counterOffer(state, session, round, playerId, action);
    case "accept-offer":
      return acceptOffer(state, session, playerId, action.offerId);
    case "reject-offer":
      return rejectOrWithdraw(state, session, playerId, action.offerId, "rejected");
    case "withdraw-offer":
      return rejectOrWithdraw(state, session, playerId, action.offerId, "withdrawn");
    default:
      return undefined;
  }
};

const windowMatchesState = (state: GameState, session: NegotiationSession): boolean => {
  if (state.phase.tag !== "turn.action") return false;
  return (
    state.phase.turn === session.turn &&
    state.sequence === session.gameSequence &&
    state.config.players[state.phase.playerIndex]?.id === session.turnPlayerId
  );
};

const validateActionContext = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
): Effect.Effect<void, NegotiationViolation> =>
  Effect.gen(function* () {
    if (
      session.closed ||
      state.matchId !== session.matchId ||
      !windowMatchesState(state, session)
    ) {
      return yield* fail("invalid-window", "The negotiation window is closed or mismatched.");
    }
    if (!playerExists(state, playerId)) {
      return yield* fail("wrong-player", "The negotiation actor is not in this match.");
    }
    if (!Number.isSafeInteger(round) || round < 1 || round > session.policy.maxRounds) {
      return yield* fail("invalid-window", "The negotiation round is outside the policy limit.");
    }
  });

export const applyNegotiationAction = (
  state: GameState,
  session: NegotiationSession,
  round: number,
  playerId: PlayerId,
  input: unknown,
): Effect.Effect<NegotiationActionResult, NegotiationViolation> =>
  Effect.gen(function* () {
    yield* validateActionContext(state, session, round, playerId);
    const action = (yield* decodeNegotiationAction(input).pipe(
      Effect.mapError(
        () =>
          new NegotiationViolation({
            code: "invalid-action",
            message: "The negotiation action is malformed.",
          }),
      ),
    )) as NegotiationAction;
    const decision =
      applyCommunicationAction(state, session, round, playerId, action) ??
      applyOfferAction(state, session, round, playerId, action);
    return decision === undefined
      ? yield* fail("invalid-action", "The negotiation action is unsupported.")
      : yield* decision;
  });

export const closeNegotiationWindow = (
  state: GameState,
  session: NegotiationSession,
  reason: "all-passed" | "round-limit" | "game-ended",
): NegotiationSession => {
  if (session.closed) return session;
  const expired = expireOpenOffers(state, session);
  return {
    ...appendEvent(expired, state.sequence, {
      type: "negotiation.window-closed",
      windowId: session.windowId,
      reason,
    }),
    closed: true,
  };
};

const scopeVisible = (scope: NegotiationScope, ownerPlayerId: PlayerId, viewer: Viewer): boolean =>
  scope.type === "public" ||
  (viewer.type === "player" && scopeIncludesPlayer(scope, ownerPlayerId, viewer.playerId));

const offerVisible = (offer: TradeOffer, viewer: Viewer): boolean =>
  offer.scope.type === "public" ||
  (viewer.type === "player" &&
    (viewer.playerId === offer.proposerPlayerId || viewer.playerId === offer.targetPlayerId));

const promiseVisible = (promise: NegotiationPromise, viewer: Viewer): boolean =>
  scopeVisible(promise.scope, promise.playerId, viewer);

const offerIdFromEvent = (event: NegotiationEvent): string | null => {
  switch (event.event.type) {
    case "trade.offer-closed":
    case "trade.offer-accepted":
    case "trade.offer-failed":
      return event.event.offerId;
    default:
      return null;
  }
};

const eventVisible = (
  session: NegotiationSession,
  event: NegotiationEvent,
  viewer: Viewer,
): boolean => {
  const offerId = offerIdFromEvent(event);
  if (offerId !== null) {
    const offer = session.offers.find(({ id }) => id === offerId);
    return offer !== undefined && offerVisible(offer, viewer);
  }
  switch (event.event.type) {
    case "negotiation.message-sent":
      return scopeVisible(event.event.scope, event.event.playerId, viewer);
    case "trade.offer-created":
      return offerVisible(event.event.offer, viewer);
    case "negotiation.promise-recorded":
      return promiseVisible(event.event.promise, viewer);
    case "negotiation.promise-evidence-recorded": {
      const promiseId = event.event.evidence.promiseId;
      const promise = session.promises.find(({ id }) => id === promiseId);
      return promise !== undefined && promiseVisible(promise, viewer);
    }
    default:
      return true;
  }
};

export interface NegotiationProjectionOptions {
  readonly eventOffset?: number;
  readonly currentWindowOffersOnly?: boolean;
}

export const projectNegotiation = (
  session: NegotiationSession,
  viewer: Viewer = { type: "public" },
  options: NegotiationProjectionOptions = {},
): NegotiationView => {
  const promises = session.promises.filter((promise) => promiseVisible(promise, viewer));
  const promiseIds = new Set(promises.map(({ id }) => id));
  const events = session.events.slice(options.eventOffset ?? 0);
  const offers = options.currentWindowOffersOnly
    ? session.offers.filter(({ id }) => id.startsWith(`${session.windowId}:offer:`))
    : session.offers;
  return {
    schema: "catanarchy.negotiation-view.v1",
    matchId: session.matchId,
    sequence: session.sequence,
    events: events.filter((event) => eventVisible(session, event, viewer)),
    offers: offers.filter((offer) => offerVisible(offer, viewer)),
    promises,
    evidence: session.evidence.filter(({ promiseId }) => promiseIds.has(promiseId)),
  };
};
