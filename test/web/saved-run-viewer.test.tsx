// @vitest-environment jsdom

import { createGame, handleCommand, legalActions } from "@catanarchy/engine";
import type { GameConfig } from "@catanarchy/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunPackage, loadRunReport } from "../../apps/web/src/RunReport.js";
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
    expect(screen.queryByText("model · 1 calls · 12 tok · $0.0010")).toBeNull();
    expect(screen.queryByText("red (public): I need brick.")).toBeNull();
    expect(screen.queryByText("Strong production.")).toBeNull();
    expect(run.frameDurationsMs).toEqual([12]);
    expect(run.timingSource).toBe("recorded-model-time");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByText("red (public): I need brick.")).toBeTruthy();
    expect(screen.getByText("red: settlement:v:0:0")).toBeTruthy();
    expect(screen.getByText("model · 1 calls · 12 tok · $0.0010")).toBeTruthy();
    expect(screen.getByText("model · 12 tok · $0.0010 · 12 ms")).toBeTruthy();
    expect(screen.getByText("Strong production.")).toBeTruthy();
    expect(screen.getByText("recorded model time")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Replay time"), { target: { value: "12" } });
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByText("0:00:00 / 0:00:00")).toBeTruthy();

    const speed = screen.getByRole("combobox", { name: "Playback speed" });
    expect((speed as HTMLSelectElement).value).toBe("100");
    expect(screen.getByRole("option", { name: "1000×" })).toBeTruthy();
    fireEvent.change(speed, { target: { value: "1000" } });
    expect((speed as HTMLSelectElement).value).toBe("1000");
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });

  it("loads exact record timing and native Pi session links from a run package", async () => {
    const created = Effect.runSync(createGame(config));
    const action = legalActions(created.state)[0];
    if (action === undefined) throw new Error("Expected one setup action.");
    const handled = Effect.runSync(handleCommand(created.state, action.command));
    const decision = {
      sequence: created.state.sequence,
      playerId: "red",
      attempt: 1,
      outcome: "selected",
      actionId: action.id,
      elapsedMs: 10,
    } as const;
    const message = {
      schema: "catanarchy.negotiation-event.v1",
      matchId: config.matchId,
      sequence: 0,
      gameSequence: created.state.sequence,
      event: {
        type: "negotiation.message-sent",
        round: 1,
        playerId: "red",
        scope: { type: "public" },
        text: "Trade?",
      },
    } as const;
    const values = [
      ["run.started", { config }],
      ["game.event", created.events[0]],
      [
        "game.command-completed",
        { matchId: config.matchId, commandId: created.events[0]?.commandId, sequence: 0 },
      ],
      ["game.decision", decision],
      ["negotiation.event", message],
      ["game.event", handled.events[0]],
      [
        "game.command-completed",
        { matchId: config.matchId, commandId: handled.events[0]?.commandId, sequence: 1 },
      ],
      ["run.completed", { gameSequence: 1, negotiationSequence: 0, winnerPlayerId: null }],
    ] as const;
    const offsets = [0, 1, 2, 12, 13, 19, 20, 21];
    const run = await loadRunPackage({
      manifest: {
        schema: "catanarchy.run-manifest.v1",
        runId: "run-package-test",
        matchId: config.matchId,
        status: "completed",
        initialStateOrigin: {
          type: "generated",
          generatorId: "catanarchy.standard-board.v1",
          seed: config.seed,
        },
        seats: [
          {
            seatId: "red",
            sessionFile: "sessions/red.jsonl",
          },
        ],
      },
      records: values.map(([kind, payload], index) => ({
        schema: "catanarchy.run-record.v1",
        runId: "run-package-test",
        index,
        offsetMs: offsets[index],
        recordedAt: new Date(0).toISOString(),
        visibility: "referee",
        kind,
        payload,
      })),
      verification: {
        generatorMatch: "matches-current",
        commandVerification: "exact",
      },
    });

    expect(run.frames).toHaveLength(4);
    expect(run.frameDurationsMs).toEqual([10, 1, 7]);
    expect(run.timingSource).toBe("recorded-time");
    expect(run.state).toEqual(handled.state);
    expect(run.sessionSeatIds).toEqual(["red"]);
    expect(run.initialStateOrigin).toEqual({
      type: "generated",
      generatorId: "catanarchy.standard-board.v1",
      seed: config.seed,
    });

    render(<SavedRunViewer run={run} />);
    expect(screen.getByText(/replay valid/u)).toBeTruthy();
    expect(screen.getByText(/board generated by catanarchy\.standard-board\.v1/u)).toBeTruthy();
    expect(screen.getByText(/matches current generator/u)).toBeTruthy();
    expect(screen.getByText(/native commands verified exactly/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pi session" }).getAttribute("href")).toBe(
      "/__catanarchy/session/red",
    );

    cleanup();
    render(
      <SavedRunViewer
        run={{
          ...run,
          initialStateOrigin: { type: "observed", adapterId: "colonist.test" },
          generatorMatch: "not-applicable",
          commandVerification: "not-applicable",
        }}
      />,
    );
    expect(screen.getByText(/board observed by colonist\.test/u)).toBeTruthy();
    expect(screen.getByText(/generator check not applicable/u)).toBeTruthy();
    expect(screen.getByText(/native command check not applicable/u)).toBeTruthy();
  });

  it("opens a failed run at its last complete command", async () => {
    const created = Effect.runSync(createGame(config));
    const createdEvent = created.events[0];
    const action = legalActions(created.state)[0];
    if (createdEvent === undefined || action === undefined) {
      throw new Error("Expected an initialized game and setup action.");
    }
    const handled = Effect.runSync(handleCommand(created.state, action.command));
    const incompleteEvent = handled.events[0];
    if (incompleteEvent === undefined) throw new Error("Expected a settlement event.");
    const values = [
      ["run.started", { config }],
      ["game.event", createdEvent],
      [
        "game.command-completed",
        {
          matchId: config.matchId,
          commandId: createdEvent.commandId,
          sequence: createdEvent.sequence,
        },
      ],
      ["game.event", incompleteEvent],
      [
        "run.failed",
        {
          gameSequence: incompleteEvent.sequence,
          negotiationSequence: -1,
          winnerPlayerId: null,
          reason: "activity write failed",
        },
      ],
    ] as const;
    const run = await loadRunPackage({
      manifest: {
        schema: "catanarchy.run-manifest.v1",
        runId: "interrupted-run",
        matchId: config.matchId,
        status: "failed",
        initialStateOrigin: {
          type: "generated",
          generatorId: "catanarchy.standard-board.v1",
          seed: config.seed,
        },
        seats: [],
      },
      records: values.map(([kind, payload], index) => ({
        schema: "catanarchy.run-record.v1",
        runId: "interrupted-run",
        index,
        offsetMs: index,
        recordedAt: new Date(index).toISOString(),
        visibility: "referee",
        kind,
        payload,
      })),
      verification: { generatorMatch: "matches-current", commandVerification: "exact" },
    });

    expect(run.status).toBe("failed");
    expect(run.state).toEqual(created.state);
    expect(run.frames).toHaveLength(1);
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
    expect(run.frames).toHaveLength(commandCount);
    expect(run.state).toEqual(state);
    expect(run.timingSource).toBe("synthetic");
    expect(run.frameDurationsMs.every((duration) => duration === 1_000)).toBe(true);
  });

  it("rejects input without a game-event log", async () => {
    await expect(loadRunReport({ result: {} })).rejects.toThrow("game-event log");
  });
});
