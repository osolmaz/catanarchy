// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTimestampPlayback } from "../../apps/web/src/useTimestampPlayback.js";

const frames = [{ offsetMs: 0 }, { offsetMs: 1_000 }, { offsetMs: 2_000 }];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("timestamp playback hook", () => {
  it("advances frames against the scaled absolute clock", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTimestampPlayback(frames, 0, false, 2));

    act(() => result.current.togglePlaying());
    expect(result.current.playing).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(result.current.frameIndex).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.frameIndex).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(result.current.frameIndex).toBe(2);
    expect(result.current.playing).toBe(false);
  });

  it("keeps partial replay time when the speed changes", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ speed }: { readonly speed: number }) => useTimestampPlayback(frames, 0, false, speed),
      { initialProps: { speed: 1 } },
    );

    act(() => result.current.togglePlaying());
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(result.current.frameIndex).toBe(0);

    rerender({ speed: 2 });
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(result.current.frameIndex).toBe(1);
  });

  it("seeks to an exact frame and stops playback", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTimestampPlayback(frames, 0, false, 1));

    act(() => result.current.togglePlaying());
    act(() => result.current.seek(2));

    expect(result.current.frameIndex).toBe(2);
    expect(result.current.playing).toBe(false);
  });
});
