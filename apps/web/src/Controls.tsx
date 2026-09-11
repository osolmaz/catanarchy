import { useEffect } from "react";

export interface Playback {
  readonly playing: boolean;
  readonly onToggle: () => void;
  readonly speed: number;
  readonly speedOptions: ReadonlyArray<number>;
  readonly onSpeed: (speed: number) => void;
  readonly note: string;
  readonly elapsedMs: number;
  readonly totalMs: number;
  readonly onSeekTime: (offsetMs: number) => void;
}

interface ControlsProps {
  readonly index: number;
  readonly count: number;
  readonly onSeek: (index: number) => void;
  readonly playback?: Playback;
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d={d} fill="currentColor" />
  </svg>
);

const ICON = {
  first: "M2 2h2v12H2zM14 2 6 8l8 6z",
  previous: "M12 2 4 8l8 6z",
  next: "M4 2l8 6-8 6z",
  last: "M12 2h2v12h-2zM2 2l8 6-8 6z",
  play: "M4 2l10 6-10 6z",
  pause: "M3 2h4v12H3zM9 2h4v12H9z",
};

export const formatPlaybackTime = (milliseconds: number): string => {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && target.closest("input, select, textarea, button, a") !== null;

const useKeys = (props: ControlsProps): void => {
  const { index, count, onSeek, playback } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return;
      const handlers: Readonly<Record<string, () => void>> = {
        ArrowLeft: () => onSeek(Math.max(0, index - 1)),
        ArrowRight: () => onSeek(Math.min(count - 1, index + 1)),
        Home: () => onSeek(0),
        End: () => onSeek(count - 1),
        " ": () => playback?.onToggle(),
      };
      const handler = handlers[event.key];
      if (handler === undefined) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, count, onSeek, playback]);
};

/** One-line frame navigation: step buttons, a scrubber, and optional timed playback. */
export const Controls = (props: ControlsProps) => {
  const { index, count, onSeek, playback } = props;
  const last = count - 1;
  useKeys(props);
  return (
    <div className="controls" role="toolbar" aria-label="Frame controls">
      <button
        type="button"
        aria-label="First"
        title="First (Home)"
        disabled={index === 0}
        onClick={() => onSeek(0)}
      >
        <Icon d={ICON.first} />
      </button>
      <button
        type="button"
        aria-label="Previous"
        title="Previous (←)"
        disabled={index === 0}
        onClick={() => onSeek(index - 1)}
      >
        <Icon d={ICON.previous} />
      </button>
      {playback === undefined ? null : (
        <button
          type="button"
          aria-label={playback.playing ? "Pause" : "Play"}
          title={playback.playing ? "Pause (space)" : "Play (space)"}
          disabled={index === last}
          onClick={playback.onToggle}
        >
          <Icon d={playback.playing ? ICON.pause : ICON.play} />
        </button>
      )}
      <button
        type="button"
        aria-label="Next"
        title="Next (→)"
        disabled={index === last}
        onClick={() => onSeek(index + 1)}
      >
        <Icon d={ICON.next} />
      </button>
      <button
        type="button"
        aria-label="Last"
        title="Last (End)"
        disabled={index === last}
        onClick={() => onSeek(last)}
      >
        <Icon d={ICON.last} />
      </button>
      {playback === undefined ? (
        <input
          type="range"
          aria-label="Frame"
          min={0}
          max={last}
          value={index}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      ) : (
        <input
          type="range"
          aria-label="Replay time"
          aria-valuetext={`${formatPlaybackTime(playback.elapsedMs)} of ${formatPlaybackTime(playback.totalMs)}`}
          min={0}
          max={Math.max(1, playback.totalMs)}
          step={1}
          value={playback.elapsedMs}
          onChange={(event) => playback.onSeekTime(Number(event.target.value))}
        />
      )}
      {playback === undefined ? null : (
        <span className="time" aria-live="off">
          {formatPlaybackTime(playback.elapsedMs)} / {formatPlaybackTime(playback.totalMs)}
        </span>
      )}
      <span className="frame">
        {index + 1} / {count}
      </span>
      {playback === undefined ? null : (
        <>
          <select
            className="speed"
            aria-label="Playback speed"
            title="Playback speed"
            value={playback.speed}
            onChange={(event) => playback.onSpeed(Number(event.target.value))}
          >
            {playback.speedOptions.map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
          <small>{playback.note}</small>
        </>
      )}
    </div>
  );
};
