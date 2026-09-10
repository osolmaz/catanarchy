// @vitest-environment jsdom

import { createGame } from "@catanarchy/engine";
import type { GameConfig } from "@catanarchy/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunReport } from "../../apps/web/src/RunReport.js";
import { SavedRunViewer } from "../../apps/web/src/SavedRunViewer.js";

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "saved-run-test",
  seed: 42,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
  ],
};

afterEach(cleanup);

describe("saved run viewer", () => {
  it("replays a saved report and shows negotiation and model traces", async () => {
    const created = Effect.runSync(createGame(config));
    const run = await loadRunReport({
      result: {
        state: created.state,
        events: created.events,
        negotiations: [
          {
            schema: "catanarchy.negotiation-event.v1",
            matchId: config.matchId,
            sequence: 0,
            gameSequence: 0,
            event: {
              type: "negotiation.message-sent",
              round: 1,
              playerId: "red",
              scope: { type: "public" },
              text: "I need brick.",
            },
          },
        ],
        negotiationSession: { offers: [], promises: [], evidence: [] },
        decisions: [
          {
            sequence: 0,
            playerId: "red",
            attempt: 1,
            outcome: "selected",
            actionId: "settlement:v:0:0",
            reason: "Strong production.",
            model: { provider: "test", modelId: "model" },
            elapsedMs: 12,
            usage: {
              input: 10,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              total: 12,
              cost: 0.001,
            },
            selectionMode: "tool",
          },
        ],
        negotiationDecisions: [],
      },
    });

    render(<SavedRunViewer run={run} />);

    expect(screen.getByRole("heading", { name: "Inspect saved-run-test" })).toBeTruthy();
    expect(screen.getByText("red (public): I need brick.")).toBeTruthy();
    expect(screen.getByText("test/model")).toBeTruthy();
    expect(screen.getByText("Strong production.")).toBeTruthy();
    expect(screen.getByText(/Raw Pi message history was not saved/)).toBeTruthy();
  });

  it("rejects input without a game-event log", async () => {
    await expect(loadRunReport({ result: {} })).rejects.toThrow("game-event log");
  });
});
