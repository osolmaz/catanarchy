import { describe, expect, it } from "vitest";
import { frameIndexAtOffset, playbackOffsetAt } from "../../apps/web/src/playback.js";

describe("timestamp playback", () => {
  it("derives replay time from one absolute wall-clock anchor", () => {
    const anchor = { wallTimeMs: 1_000, timelineOffsetMs: 400, speed: 5 };

    expect(playbackOffsetAt(anchor, 1_250, 5_000)).toBe(1_650);
    expect(playbackOffsetAt(anchor, 900, 5_000)).toBe(400);
    expect(playbackOffsetAt(anchor, 2_000, 2_000)).toBe(2_000);
  });

  it("catches up to the latest frame at or before the replay timestamp", () => {
    const frames = [
      { offsetMs: 0 },
      { offsetMs: 100 },
      { offsetMs: 100 },
      { offsetMs: 250 },
      { offsetMs: 1_000 },
    ];

    expect(frameIndexAtOffset(frames, -1)).toBe(0);
    expect(frameIndexAtOffset(frames, 99)).toBe(0);
    expect(frameIndexAtOffset(frames, 100)).toBe(2);
    expect(frameIndexAtOffset(frames, 900)).toBe(3);
    expect(frameIndexAtOffset(frames, 1_500)).toBe(4);
  });

  it("rejects an empty replay", () => {
    expect(() => frameIndexAtOffset([], 0)).toThrow("at least one frame");
  });
});
