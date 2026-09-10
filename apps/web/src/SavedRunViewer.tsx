import { observe } from "@catanarchy/engine";
import { useCallback, useEffect, useRef, useState } from "react";
import { Board } from "./Board.js";
import { Controls } from "./Controls.js";
import { Feed, type FeedItem } from "./Feed.js";
import { negotiationFeedItems } from "./NegotiationTimeline.js";
import { phaseText } from "./phase.js";
import { Players } from "./Players.js";
import type { LoadedRunReport } from "./RunReport.js";
import { decisionFeedItems, sessionSummaries, sessionText } from "./traces.js";

export interface SavedRunViewerProps {
  readonly run: LoadedRunReport;
  readonly live?: boolean;
}

const SPEEDS = [1, 2, 5, 10, 20] as const;

const timingNote = (source: LoadedRunReport["timingSource"]): string => {
  switch (source) {
    case "recorded-time":
      return "recorded time";
    case "recorded-model-time":
      return "recorded model time";
    case "mixed":
      return "recorded model time, 1 s gaps";
    case "synthetic":
      return "1 s per command";
  }
};

/** Optional `?frame=N` selects the initial one-based frame; the URL never carries match data. */
const initialFrame = (count: number, live: boolean): number => {
  const requested = Number(new URLSearchParams(window.location.search).get("frame"));
  return Number.isInteger(requested) && requested >= 1
    ? Math.min(requested, count) - 1
    : live
      ? count - 1
      : 0;
};

const gameFeedItems = (events: ReadonlyArray<LoadedRunReport["events"][number]>): FeedItem[] =>
  events.map((event) => ({
    key: `event:${event.sequence}`,
    sequence: event.sequence,
    order: Number.MIN_SAFE_INTEGER,
    kind: "event",
    text: event.event.type,
  }));

export const SavedRunViewer = ({ run, live = false }: SavedRunViewerProps) => {
  const [frameIndex, setFrameIndex] = useState(() => initialFrame(run.frames.length, live));
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(0);
  const previousFrameCount = useRef(run.frames.length);
  const speed = SPEEDS[speedIndex] ?? 1;
  const latestIndex = run.frames.length - 1;
  const frame = run.frames[frameIndex] ?? run.frames.at(-1);
  if (frame === undefined) throw new Error("The run has no replay frame.");
  const state = frame.state;
  const observation = observe(state, { type: "public" });
  const visibleEvents = run.events.slice(0, frame.gameEventCount);
  const visibleNegotiationEvents = run.negotiation.events.slice(0, frame.negotiationEventCount);
  const visibleDecisions = run.decisions.slice(0, frame.decisionCount);
  const visibleNegotiationDecisions = run.negotiationDecisions.slice(
    0,
    frame.negotiationDecisionCount,
  );
  const sessions = sessionSummaries([...visibleDecisions, ...visibleNegotiationDecisions]);
  const visibleNegotiation = { ...run.negotiation, events: visibleNegotiationEvents };
  const items = [
    ...gameFeedItems(visibleEvents),
    ...negotiationFeedItems(visibleNegotiation, visibleEvents),
    ...decisionFeedItems(visibleDecisions, "decision"),
    ...decisionFeedItems(visibleNegotiationDecisions, "negotiation-decision"),
  ];

  useEffect(() => {
    const oldCount = previousFrameCount.current;
    previousFrameCount.current = run.frames.length;
    setFrameIndex((current) =>
      live && current >= oldCount - 1 ? latestIndex : Math.min(current, latestIndex),
    );
  }, [latestIndex, live, run.frames.length]);

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
  const cycleSpeed = useCallback(() => setSpeedIndex((index) => (index + 1) % SPEEDS.length), []);
  const sessionSeats = new Set(run.sessionSeatIds);

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
        count={run.frames.length}
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
            {live && run.status === "partial" ? <b className="live">live</b> : null}
            <span>{state.matchId}</span> · event {state.sequence} ·{" "}
            <a href="?mode=play">play locally</a>
          </small>
        </header>
        <Players
          observation={observation}
          note={(id) => (
            <>
              {sessionText(sessions.get(id))}
              {sessionSeats.has(id) ? (
                <>
                  {" · "}
                  <a href={`/__catanarchy/session/${encodeURIComponent(id)}`}>Pi session</a>
                </>
              ) : null}
            </>
          )}
        />
        <Feed items={items} empty="No records yet." label="Run feed" />
      </aside>
    </main>
  );
};
