import { useCallback, useEffect, useRef, useState } from "react";
import {
  frameIndexAtOffset,
  playbackOffsetAt,
  type PlaybackAnchor,
  type TimedFrame,
} from "./playback.js";

export interface TimestampPlayback {
  readonly frameIndex: number;
  readonly offsetMs: number;
  readonly playing: boolean;
  readonly seek: (index: number) => void;
  readonly seekOffset: (offsetMs: number) => void;
  readonly togglePlaying: () => void;
}

export const useTimestampPlayback = (
  frames: ReadonlyArray<TimedFrame>,
  initialFrameIndex: number,
  live: boolean,
  speed: number,
): TimestampPlayback => {
  const [frameIndex, setFrameIndex] = useState(initialFrameIndex);
  const [offsetMs, setOffsetMs] = useState(frames[initialFrameIndex]?.offsetMs ?? 0);
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
    const current = frameIndexRef.current;
    const followLive = live && !playingRef.current && current >= oldCount - 1;
    const next = followLive ? latestIndex : Math.min(current, latestIndex);
    frameIndexRef.current = next;
    setFrameIndex(next);
    if (!playingRef.current) {
      const nextOffsetMs = frames[next]?.offsetMs ?? 0;
      playbackOffsetRef.current = nextOffsetMs;
      setOffsetMs(nextOffsetMs);
    }
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
      setOffsetMs(targetOffsetMs);
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
      const frameDelayMs = Math.max(1, Math.ceil((nextOffsetMs - targetOffsetMs) / speed));
      timer = setTimeout(advance, Math.min(frameDelayMs, 100));
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
      const nextOffsetMs = frames[index]?.offsetMs ?? 0;
      playbackOffsetRef.current = nextOffsetMs;
      setOffsetMs(nextOffsetMs);
      frameIndexRef.current = index;
      setFrameIndex(index);
    },
    [frames],
  );
  const seekOffset = useCallback(
    (requestedOffsetMs: number): void => {
      const finalOffsetMs = frames[latestIndex]?.offsetMs ?? 0;
      const nextOffsetMs = Math.min(finalOffsetMs, Math.max(0, requestedOffsetMs));
      const nextIndex = frameIndexAtOffset(frames, nextOffsetMs);
      playingRef.current = false;
      setPlaying(false);
      playbackAnchorRef.current = null;
      playbackOffsetRef.current = nextOffsetMs;
      setOffsetMs(nextOffsetMs);
      frameIndexRef.current = nextIndex;
      setFrameIndex(nextIndex);
    },
    [frames, latestIndex],
  );
  const togglePlaying = useCallback((): void => {
    setPlaying((current) => {
      if (current) {
        const finalOffsetMs = frames[latestIndex]?.offsetMs ?? 0;
        const anchor = playbackAnchorRef.current;
        const nextOffsetMs =
          anchor === null
            ? playbackOffsetRef.current
            : playbackOffsetAt(anchor, performance.now(), finalOffsetMs);
        playbackOffsetRef.current = nextOffsetMs;
        setOffsetMs(nextOffsetMs);
        playbackAnchorRef.current = null;
        playingRef.current = false;
        return false;
      }
      const next = frameIndexRef.current < latestIndex;
      playingRef.current = next;
      return next;
    });
  }, [frames, latestIndex]);

  return { frameIndex, offsetMs, playing, seek, seekOffset, togglePlaying };
};
