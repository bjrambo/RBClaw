import { afterEach, describe, expect, it, vi } from 'vitest';

import { scrollRoomDetailToBottom } from './roomDetailScroll';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scrollRoomDetailToBottom', () => {
  it('keeps the room detail pinned to the latest height across render frames', () => {
    const detail = { scrollHeight: 120, scrollTop: 0 };
    const frames: FrameRequestCallback[] = [];
    const querySelector = vi.fn(() => detail);

    vi.stubGlobal('document', { querySelector });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );

    scrollRoomDetailToBottom();

    expect(detail.scrollTop).toBe(0);
    expect(querySelector).toHaveBeenCalledWith('.rooms-detail');

    let frame = frames.shift();
    frame?.(0);
    expect(detail.scrollTop).toBe(120);

    detail.scrollHeight = 240;
    while ((frame = frames.shift())) frame(0);

    expect(detail.scrollTop).toBe(240);
  });

  it('does nothing when the room detail is not mounted', () => {
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
    vi.stubGlobal('requestAnimationFrame', vi.fn());

    expect(() => scrollRoomDetailToBottom()).not.toThrow();
  });
});
