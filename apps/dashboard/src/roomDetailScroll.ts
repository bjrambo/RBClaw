const ROOM_DETAIL_SCROLL_FRAMES = 3;

export function scrollRoomDetailToBottom(): void {
  if (
    typeof document === 'undefined' ||
    typeof requestAnimationFrame === 'undefined'
  ) {
    return;
  }

  const detail = document.querySelector('.rooms-detail') as HTMLElement | null;
  if (!detail) return;

  const scroll = (framesRemaining: number) => {
    detail.scrollTop = detail.scrollHeight;
    if (framesRemaining > 0) {
      requestAnimationFrame(() => scroll(framesRemaining - 1));
    }
  };

  requestAnimationFrame(() => scroll(ROOM_DETAIL_SCROLL_FRAMES));
}
