export interface TimedFrame {
  readonly offsetMs: number;
}

export interface PlaybackAnchor {
  readonly wallTimeMs: number;
  readonly timelineOffsetMs: number;
  readonly speed: number;
}

export const playbackOffsetAt = (
  anchor: PlaybackAnchor,
  wallTimeMs: number,
  finalOffsetMs: number,
): number => {
  const elapsedMs = Math.max(0, wallTimeMs - anchor.wallTimeMs);
  return Math.min(finalOffsetMs, anchor.timelineOffsetMs + elapsedMs * anchor.speed);
};

export const frameIndexAtOffset = (frames: ReadonlyArray<TimedFrame>, offsetMs: number): number => {
  if (frames.length === 0) throw new Error("Playback requires at least one frame.");
  let lower = 0;
  let upper = frames.length - 1;
  let match = 0;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const frame = frames[middle];
    if (frame !== undefined && frame.offsetMs <= offsetMs) {
      match = middle;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return match;
};
