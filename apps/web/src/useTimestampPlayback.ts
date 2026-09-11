import { useCallback, useEffect, useRef, useState } from "react";
import {
  frameIndexAtOffset,
  playbackOffsetAt,
  type PlaybackAnchor,
  type TimedFrame,
} from "./playback.js";

export interface TimestampPlayback {
  readonly frameIndex: number;
  readonly playing: boolean;
  readonly seek: (index: number) => void;
  readonly togglePlaying: () => void;
}

export const useTimestampPlayback = (
  frames: ReadonlyArray<TimedFrame>,
  initialFrameIndex: number,
  live: boolean,
  speed: number,
): TimestampPlayback => {
  const [frameIndex, setFrameIndex] = useState(initialFrameIndex);
  const [playing, setPlaying] = useState(false);
  const previousFrameCount = useRef(frames.length);
  const frameIndexRef = useRef(frameIndex);
  const playingRef = useRef(playing);
  const playbackOffsetRef = useRef(frames[frameIndex]?.offsetMs ?? 0);
  const playbackAnchorRef = useRef<PlaybackAnchor | null>(null);
  const latestIndex = frames.length - 1;

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    const oldCount = previousFrameCount.current;
    previousFrameCount.current = frames.length;
    setFrameIndex((current) => {
      const followLive = live && !playingRef.current && current >= oldCount - 1;
      const next = followLive ? latestIndex : Math.min(current, latestIndex);
      frameIndexRef.current = next;
      if (!playingRef.current) playbackOffsetRef.current = frames[next]?.offsetMs ?? 0;
      return next;
    });
  }, [frames, latestIndex, live]);

  useEffect(() => {
    const finalOffsetMs = frames[latestIndex]?.offsetMs;
    if (!playing || finalOffsetMs === undefined || frameIndexRef.current >= latestIndex) {
      playbackAnchorRef.current = null;
      return;
    }

    const now = performance.now();
    const previousAnchor = playbackAnchorRef.current;
    const timelineOffsetMs =
      previousAnchor === null
        ? playbackOffsetRef.current
        : playbackOffsetAt(previousAnchor, now, finalOffsetMs);
    playbackOffsetRef.current = timelineOffsetMs;
    const anchor: PlaybackAnchor = { wallTimeMs: now, timelineOffsetMs, speed };
    playbackAnchorRef.current = anchor;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const advance = (): void => {
      const targetOffsetMs = playbackOffsetAt(anchor, performance.now(), finalOffsetMs);
      playbackOffsetRef.current = targetOffsetMs;
      const nextIndex = frameIndexAtOffset(frames, targetOffsetMs);
      if (nextIndex !== frameIndexRef.current) {
        frameIndexRef.current = nextIndex;
        setFrameIndex(nextIndex);
      }
      if (nextIndex >= latestIndex) {
        playbackAnchorRef.current = null;
        playingRef.current = false;
        setPlaying(false);
        return;
      }
      const nextOffsetMs = frames[nextIndex + 1]?.offsetMs ?? finalOffsetMs;
      const delayMs = Math.max(1, Math.ceil((nextOffsetMs - targetOffsetMs) / speed));
      timer = setTimeout(advance, delayMs);
    };

    advance();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (playbackAnchorRef.current === anchor) {
        playbackOffsetRef.current = playbackOffsetAt(anchor, performance.now(), finalOffsetMs);
        playbackAnchorRef.current = null;
      }
    };
  }, [frames, latestIndex, playing, speed]);

  const seek = useCallback(
    (index: number): void => {
      playingRef.current = false;
      setPlaying(false);
      playbackAnchorRef.current = null;
      playbackOffsetRef.current = frames[index]?.offsetMs ?? 0;
      frameIndexRef.current = index;
      setFrameIndex(index);
    },
    [frames],
  );
  const togglePlaying = useCallback((): void => {
    setPlaying((current) => {
      const next = !current && frameIndexRef.current < latestIndex;
      playingRef.current = next;
      return next;
    });
  }, [latestIndex]);

  return { frameIndex, playing, seek, togglePlaying };
};
