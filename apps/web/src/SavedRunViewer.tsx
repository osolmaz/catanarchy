import { observe } from "@catanarchy/engine";
import { useCallback, useEffect, useState } from "react";
import { Board } from "./Board.js";
import { Controls } from "./Controls.js";
import { Feed } from "./Feed.js";
import { negotiationFeedItems } from "./NegotiationTimeline.js";
import { phaseText } from "./phase.js";
import { Players } from "./Players.js";
import type { LoadedRunReport, RunTrace } from "./RunReport.js";
import { decisionFeedItems, sessionSummaries, sessionText } from "./traces.js";

export interface SavedRunViewerProps {
  readonly run: LoadedRunReport;
}

const SPEEDS = [1, 2, 5, 10, 20] as const;

const gameTraceVisible = (trace: RunTrace, gameSequence: number): boolean =>
  trace.sequence !== undefined && trace.sequence < gameSequence;

const negotiationTraceVisible = (trace: RunTrace, gameSequence: number): boolean =>
  trace.gameSequence !== undefined && trace.gameSequence < gameSequence;

const timingNote = (source: LoadedRunReport["timingSource"]): string => {
  switch (source) {
    case "recorded-model-time":
      return "recorded model time";
    case "mixed":
      return "recorded model time, 1 s gaps";
    case "synthetic":
      return "1 s per command";
  }
};

/** Optional `?frame=N` selects the initial one-based frame; the URL never carries match data. */
const initialFrame = (count: number): number => {
  const requested = Number(new URLSearchParams(window.location.search).get("frame"));
  return Number.isInteger(requested) && requested >= 1 ? Math.min(requested, count) - 1 : 0;
};

export const SavedRunViewer = ({ run }: SavedRunViewerProps) => {
  const [frameIndex, setFrameIndex] = useState(() => initialFrame(run.states.length));
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(0);
  const speed = SPEEDS[speedIndex] ?? 1;
  const latestIndex = run.states.length - 1;
  const state = run.states[frameIndex] ?? run.state;
  const observation = observe(state, { type: "public" });
  const sessions = sessionSummaries([...run.decisions, ...run.negotiationDecisions]);
  const visibleNegotiation = {
    ...run.negotiation,
    events: run.negotiation.events.filter(({ gameSequence }) => gameSequence < state.sequence),
  };
  const items = [
    ...negotiationFeedItems(visibleNegotiation, run.events, state.sequence),
    ...decisionFeedItems(
      run.decisions.filter((trace) => gameTraceVisible(trace, state.sequence)),
      "decision",
    ),
    ...decisionFeedItems(
      run.negotiationDecisions.filter((trace) => negotiationTraceVisible(trace, state.sequence)),
      "negotiation-decision",
    ),
  ];

  useEffect(() => {
    if (!playing || frameIndex >= latestIndex) return;
    const duration = run.frameDurationsMs[frameIndex] ?? 1_000;
    const timer = setTimeout(() => {
      setFrameIndex((current) => current + 1);
      if (frameIndex + 1 >= latestIndex) setPlaying(false);
    }, duration / speed);
    return () => clearTimeout(timer);
  }, [frameIndex, latestIndex, playing, run.frameDurationsMs, speed]);

  const seek = useCallback((index: number): void => {
    setPlaying(false);
    setFrameIndex(index);
  }, []);
  const togglePlaying = useCallback(() => setPlaying((current) => !current), []);
  const cycleSpeed = useCallback(() => setSpeedIndex((i) => (i + 1) % SPEEDS.length), []);

  return (
    <main className="viewer">
      <div className="board-pane">
        <Board
          observation={observation}
          legalActions={[]}
          onAction={() => {}}
          interactive={false}
        />
      </div>
      <Controls
        index={frameIndex}
        count={run.states.length}
        onSeek={seek}
        playback={{
          playing,
          onToggle: togglePlaying,
          speed,
          onSpeed: cycleSpeed,
          note: timingNote(run.timingSource),
        }}
      />
      <aside>
        <header className="status" aria-live="polite">
          <strong>{phaseText(state)}</strong>
          <small>
            <span>{state.matchId}</span> · event {state.sequence} ·{" "}
            <a href="?mode=play">play locally</a>
          </small>
        </header>
        <Players observation={observation} note={(id) => sessionText(sessions.get(id))} />
        <Feed items={items} empty="No records yet." label="Run feed" />
      </aside>
    </main>
  );
};
