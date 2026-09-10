// @vitest-environment jsdom

import { createGame, handleCommand, legalActions } from "@catanarchy/engine";
import type { GameConfig } from "@catanarchy/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    const action = legalActions(created.state)[0];
    if (action === undefined) throw new Error("Expected one setup action.");
    const handled = Effect.runSync(handleCommand(created.state, action.command));
    const run = await loadRunReport({
      result: {
        state: handled.state,
        events: [...created.events, ...handled.events],
        negotiations: [
          {
            schema: "catanarchy.negotiation-event.v1",
            matchId: config.matchId,
            sequence: 0,
            gameSequence: created.state.sequence,
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
            sequence: created.state.sequence,
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

    expect(screen.getByText("saved-run-test")).toBeTruthy();
    expect(screen.getByRole("link", { name: "play locally" }).getAttribute("href")).toBe(
      "?mode=play",
    );
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByText("model · 1 calls · 12 tok · $0.0010")).toBeTruthy();
    expect(screen.queryByText("red (public): I need brick.")).toBeNull();
    expect(screen.queryByText("Strong production.")).toBeNull();
    expect(run.frameDurationsMs).toEqual([12]);
    expect(run.timingSource).toBe("recorded-model-time");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByText("red (public): I need brick.")).toBeTruthy();
    expect(screen.getByText("red: settlement:v:0:0")).toBeTruthy();
    expect(screen.getByText("model · 12 tok · $0.0010 · 12 ms")).toBeTruthy();
    expect(screen.getByText("Strong production.")).toBeTruthy();
    expect(screen.getByText("recorded model time")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Frame"), { target: { value: "1" } });
    expect(screen.getByText("2 / 2")).toBeTruthy();

    const speed = screen.getByRole("button", { name: "Playback speed" });
    expect(speed.textContent).toBe("1×");
    for (let step = 0; step < 4; step += 1) fireEvent.click(speed);
    expect(speed.textContent).toBe("20×");
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });

  it("replays multi-event commands only at atomic command boundaries", async () => {
    const created = Effect.runSync(createGame(config));
    let state = created.state;
    const events = [...created.events];
    let commandCount = 1;
    let foundMultiEventCommand = false;

    while (!foundMultiEventCommand) {
      const action = legalActions(state)[0];
      if (action === undefined) throw new Error("Expected one setup action.");
      const handled = Effect.runSync(handleCommand(state, action.command));
      state = handled.state;
      events.push(...handled.events);
      commandCount += 1;
      foundMultiEventCommand = handled.events.length > 1;
    }

    const run = await loadRunReport({ result: { state, events } });

    expect(events.length).toBeGreaterThan(commandCount);
    expect(run.states).toHaveLength(commandCount);
    expect(run.state).toEqual(state);
    expect(run.timingSource).toBe("synthetic");
    expect(run.frameDurationsMs.every((duration) => duration === 1_000)).toBe(true);
  });

  it("rejects input without a game-event log", async () => {
    await expect(loadRunReport({ result: {} })).rejects.toThrow("game-event log");
  });
});
