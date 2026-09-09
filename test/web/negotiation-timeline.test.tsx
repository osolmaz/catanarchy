// @vitest-environment jsdom

import type {
  GameEvent,
  NegotiationEvent,
  NegotiationView,
  ResourceCounts,
} from "@catanarchy/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NegotiationTimeline } from "../../apps/web/src/NegotiationTimeline.js";

const EMPTY: ResourceCounts = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };

const event = (sequence: number, payload: NegotiationEvent["event"]): NegotiationEvent => ({
  schema: "catanarchy.negotiation-event.v1",
  matchId: "viewer-negotiation",
  sequence,
  gameSequence: 20,
  event: payload,
});

const publicView: NegotiationView = {
  schema: "catanarchy.negotiation-view.v1",
  matchId: "viewer-negotiation",
  sequence: 4,
  events: [
    event(0, {
      type: "negotiation.window-opened",
      windowId: "window:1",
      turn: 1,
      turnPlayerId: "red",
      maxRounds: 3,
    }),
    event(1, {
      type: "negotiation.message-sent",
      round: 1,
      playerId: "red",
      scope: { type: "public" },
      text: "Public trade argument",
    }),
    event(2, {
      type: "trade.offer-created",
      offer: {
        id: "offer:1",
        parentOfferId: null,
        round: 2,
        gameSequence: 20,
        proposerPlayerId: "red",
        targetPlayerId: "blue",
        scope: { type: "public" },
        give: { ...EMPTY, lumber: 1 },
        receive: { ...EMPTY, brick: 1 },
        status: "accepted",
      },
    }),
    event(3, {
      type: "trade.offer-accepted",
      offerId: "offer:1",
      playerId: "blue",
      gameEventSequence: 21,
    }),
  ],
  offers: [],
  promises: [],
  evidence: [],
};

const completedTrade: GameEvent = {
  schema: "catanarchy.game-event.v1",
  matchId: "viewer-negotiation",
  sequence: 21,
  commandId: "trade:1",
  event: {
    type: "domestic-trade.completed",
    playerId: "red",
    partnerPlayerId: "blue",
    give: { ...EMPTY, lumber: 1 },
    receive: { ...EMPTY, brick: 1 },
  },
};

afterEach(cleanup);

describe("negotiation timeline", () => {
  it("renders speech, offers, and the binding settlement as different records", () => {
    render(<NegotiationTimeline negotiation={publicView} gameEvents={[completedTrade]} />);

    expect(screen.getByText(/Public trade argument/)).toBeTruthy();
    expect(screen.getByText(/offered 1 lumber.*for 1 brick/)).toBeTruthy();
    expect(screen.getByText(/settled at game event 21/)).toBeTruthy();
    expect(screen.getByText(/Binding trade: red gave 1 lumber/)).toBeTruthy();
    expect(document.querySelectorAll(".binding")).toHaveLength(2);
  });

  it("renders directed records only when they exist in the projected input", () => {
    const directed = event(4, {
      type: "negotiation.message-sent",
      round: 2,
      playerId: "blue",
      scope: { type: "direct", playerId: "red" },
      text: "Private counterargument",
    });
    const { rerender } = render(<NegotiationTimeline negotiation={publicView} gameEvents={[]} />);
    expect(screen.queryByText(/Private counterargument/)).toBeNull();

    rerender(
      <NegotiationTimeline
        negotiation={{ ...publicView, events: [...publicView.events, directed] }}
        gameEvents={[]}
      />,
    );
    expect(screen.getByText(/blue \(to red\): Private counterargument/)).toBeTruthy();
  });

  it("does not render records after the selected game sequence", () => {
    render(
      <NegotiationTimeline
        negotiation={publicView}
        gameEvents={[completedTrade]}
        throughGameSequence={20}
      />,
    );

    expect(screen.queryByText(/Binding trade/)).toBeNull();
    expect(screen.getByText(/Public trade argument/)).toBeTruthy();
  });

  it("shows an empty state for a game without negotiation", () => {
    render(
      <NegotiationTimeline
        negotiation={{ ...publicView, events: [], sequence: 0 }}
        gameEvents={[]}
      />,
    );
    expect(screen.getByText("No negotiation records.")).toBeTruthy();
  });
});
