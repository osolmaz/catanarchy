// @vitest-environment jsdom

import { createGame, handleCommand, legalActions } from "@catanarchy/engine";
import type { GameConfig } from "@catanarchy/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRunViewer } from "../../apps/web/src/LiveRunViewer.js";
import { loadRunPackage } from "../../apps/web/src/RunReport.js";

const config: GameConfig = {
  schema: "catanarchy.game-config.v1",
  matchId: "live-run-test",
  seed: 42,
  players: [
    { id: "red", name: "Red", color: "red" },
    { id: "blue", name: "Blue", color: "blue" },
    { id: "white", name: "White", color: "white" },
  ],
};

const manifest = (status: "partial" | "completed" | "failed" | "cancelled") => ({
  schema: "catanarchy.run-manifest.v1",
  runId: "live-run",
  matchId: config.matchId,
  status,
  initialStateOrigin: {
    type: "generated",
    generatorId: "catanarchy.standard-board.v1",
    seed: config.seed,
  },
  seats: [],
});

const verification = {
  generatorMatch: "matches-current",
  commandVerification: "exact",
} as const;

const runRecord = (index: number, offsetMs: number, kind: string, payload: unknown) => ({
  schema: "catanarchy.run-record.v1",
  runId: "live-run",
  index,
  offsetMs,
  recordedAt: new Date(offsetMs).toISOString(),
  visibility: "referee",
  kind,
  payload,
});

class FakeEventSource {
  static current: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly listeners = new Map<string, (event: Event) => void>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  emit(record: unknown, currentManifest: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ manifest: currentManifest, record, verification }),
      }),
    );
  }

  emitManifest(currentManifest: unknown): void {
    this.listeners.get("manifest")?.(
      new MessageEvent("manifest", { data: JSON.stringify(currentManifest) }),
    );
  }

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.current = undefined;
});

describe("live run viewer", () => {
  it("keeps the last frame, ignores duplicates, and reloads after a gap", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const created = Effect.runSync(createGame(config));
    const event = created.events[0];
    if (event === undefined) throw new Error("Expected the game-created event.");
    const records = [
      runRecord(0, 0, "run.started", { config }),
      runRecord(1, 1, "game.event", event),
      runRecord(2, 2, "game.command-completed", {
        matchId: config.matchId,
        commandId: event.commandId,
        sequence: event.sequence,
      }),
    ];
    const snapshot = { manifest: manifest("partial"), records, verification };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(new Response(JSON.stringify(snapshot), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <LiveRunViewer initialSnapshot={snapshot} initialRun={await loadRunPackage(snapshot)} />,
    );
    const source = FakeEventSource.current;
    if (source === undefined) throw new Error("Expected an event source.");

    act(() => source.onerror?.());
    expect(screen.getByText("The live connection is reconnecting.")).toBeTruthy();
    expect(screen.getByText(config.matchId)).toBeTruthy();
    act(() => source.emit(records[2], manifest("partial")));
    expect(fetch).not.toHaveBeenCalled();

    act(() => source.emit(runRecord(4, 4, "game.decision", {}), manifest("partial")));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    act(() => source.onopen?.());
    expect(screen.queryByText("The live connection is reconnecting.")).toBeNull();
  });

  it("shows a terminal failure before the first game state", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const records = [
      runRecord(0, 0, "run.started", { config }),
      runRecord(1, 1, "run.failed", {
        gameSequence: -1,
        negotiationSequence: -1,
        winnerPlayerId: null,
        reason: "The Pi match failed.",
      }),
    ];

    render(
      <LiveRunViewer
        initialSnapshot={{ manifest: manifest("failed"), records, verification }}
        initialRun={null}
      />,
    );

    expect(screen.getByText("The run ended with status: failed.")).toBeTruthy();
    expect(screen.queryByText("Waiting for the first game state.")).toBeNull();
    expect(FakeEventSource.current).toBeUndefined();
  });

  it("waits for the first command and then follows streamed records", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const started = runRecord(0, 0, "run.started", { config });
    render(
      <LiveRunViewer
        initialSnapshot={{ manifest: manifest("partial"), records: [started], verification }}
        initialRun={null}
      />,
    );
    expect(screen.getByText("Waiting for the first game state.")).toBeTruthy();
    const source = FakeEventSource.current;
    if (source === undefined) throw new Error("Expected an event source.");
    expect(source.url).toBe("/__catanarchy/run-stream?after=0");

    const created = Effect.runSync(createGame(config));
    const event = created.events[0];
    if (event === undefined) throw new Error("Expected the game-created event.");
    await act(async () => {
      source.emit(runRecord(1, 1, "game.event", event), manifest("partial"));
      source.emit(
        runRecord(2, 2, "game.command-completed", {
          matchId: config.matchId,
          commandId: event.commandId,
          sequence: event.sequence,
        }),
        manifest("partial"),
      );
    });

    expect(await screen.findByText(config.matchId)).toBeTruthy();
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getByText("game.created")).toBeTruthy();

    const action = legalActions(created.state)[0];
    if (action === undefined) throw new Error("Expected a setup action.");
    const handled = Effect.runSync(handleCommand(created.state, action.command));
    const placed = handled.events[0];
    if (placed === undefined) throw new Error("Expected a settlement event.");
    const completed = runRecord(5, 5, "run.completed", {
      gameSequence: placed.sequence,
      negotiationSequence: -1,
      winnerPlayerId: null,
    });
    const terminalSnapshot = {
      manifest: manifest("completed"),
      records: [
        started,
        runRecord(1, 1, "game.event", event),
        runRecord(2, 2, "game.command-completed", {
          matchId: config.matchId,
          commandId: event.commandId,
          sequence: event.sequence,
        }),
        runRecord(3, 3, "game.event", placed),
        runRecord(4, 4, "game.command-completed", {
          matchId: config.matchId,
          commandId: placed.commandId,
          sequence: placed.sequence,
        }),
        completed,
      ],
      verification,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () =>
        Promise.resolve(new Response(JSON.stringify(terminalSnapshot), { status: 200 })),
      ),
    );
    await act(async () => {
      source.emit(completed, manifest("completed"));
      source.emitManifest(manifest("completed"));
    });

    await waitFor(() => expect(screen.queryByText("live")).toBeNull());
    expect(screen.getByText("settlement.placed")).toBeTruthy();
    expect(source.closed).toBe(true);
  });
});
