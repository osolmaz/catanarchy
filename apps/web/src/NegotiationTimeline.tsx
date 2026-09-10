import type {
  GameEvent,
  NegotiationEvent,
  NegotiationScope,
  NegotiationView,
  ResourceCounts,
} from "@catanarchy/protocol";
import type { FeedItem } from "./Feed.js";

const RESOURCE_KEYS = ["lumber", "brick", "wool", "grain", "ore"] as const;

const bundleText = (resources: ResourceCounts): string =>
  RESOURCE_KEYS.filter((resource) => resources[resource] > 0)
    .map((resource) => `${resources[resource]} ${resource}`)
    .join(" + ");

const scopeText = (scope: NegotiationScope): string =>
  scope.type === "public" ? "public" : `to ${scope.playerId}`;

const windowEventText = (record: NegotiationEvent): string | null => {
  const event = record.event;
  switch (event.type) {
    case "negotiation.window-opened":
      return `Negotiation opened for ${event.turnPlayerId} on turn ${event.turn}`;
    case "negotiation.message-sent":
      return `${event.playerId} (${scopeText(event.scope)}): ${event.text}`;
    case "negotiation.player-passed":
      return `${event.playerId} passed in round ${event.round}`;
    case "negotiation.window-closed":
      return `Negotiation closed: ${event.reason}`;
    default:
      return null;
  }
};

const tradeEventText = (record: NegotiationEvent): string | null => {
  const event = record.event;
  switch (event.type) {
    case "trade.offer-created":
      return `${event.offer.proposerPlayerId} offered ${bundleText(event.offer.give)} to ${event.offer.targetPlayerId} for ${bundleText(event.offer.receive)} (${scopeText(event.offer.scope)})${event.offer.parentOfferId === null ? "" : ` · counter to ${event.offer.parentOfferId}`}`;
    case "trade.offer-closed":
      return `${event.offerId} ${event.status}${event.playerId === null ? "" : ` by ${event.playerId}`}`;
    case "trade.offer-accepted":
      return `${event.offerId} accepted by ${event.playerId} · settled at game event ${event.gameEventSequence}`;
    case "trade.offer-failed":
      return `${event.offerId} failed as ${event.reason}`;
    default:
      return null;
  }
};

const claimEventText = (record: NegotiationEvent): string | null => {
  const event = record.event;
  switch (event.type) {
    case "negotiation.promise-recorded":
      return `${event.promise.playerId} promised ${event.promise.beneficiaryPlayerId}: ${event.promise.text} (${scopeText(event.promise.scope)}, nonbinding)`;
    case "negotiation.promise-evidence-recorded":
      return `${event.evidence.playerId} added evidence at game event ${event.evidence.gameSequence}: ${event.evidence.text} (nonbinding)`;
    default:
      return null;
  }
};

const negotiationEventText = (record: NegotiationEvent): string =>
  windowEventText(record) ??
  tradeEventText(record) ??
  claimEventText(record) ??
  "Negotiation event";

const domesticTradeText = (record: GameEvent): string | null => {
  const event = record.event;
  return event.type === "domestic-trade.completed"
    ? `${event.playerId} gave ${bundleText(event.give)} to ${event.partnerPlayerId} for ${bundleText(event.receive)}`
    : null;
};

/**
 * Projected negotiation records and binding domestic trades as feed items.
 * The projection decides what is visible; this never filters by scope itself.
 */
export const negotiationFeedItems = (
  negotiation: NegotiationView,
  gameEvents: ReadonlyArray<GameEvent>,
  throughGameSequence = Number.MAX_SAFE_INTEGER,
): ReadonlyArray<FeedItem> => [
  ...negotiation.events
    .filter(({ gameSequence }) => gameSequence <= throughGameSequence)
    .map((event): FeedItem => ({
      key: `negotiation:${event.sequence}`,
      sequence: event.gameSequence,
      order: event.sequence,
      kind: event.event.type === "trade.offer-accepted" ? "binding" : "speech",
      text: negotiationEventText(event),
    })),
  ...gameEvents.flatMap((event): ReadonlyArray<FeedItem> => {
    const text = domesticTradeText(event);
    return text === null || event.sequence > throughGameSequence
      ? []
      : [
          {
            key: `game:${event.sequence}`,
            sequence: event.sequence,
            order: Number.MAX_SAFE_INTEGER,
            kind: "binding",
            text: `Binding trade: ${text}`,
          },
        ];
  }),
];
