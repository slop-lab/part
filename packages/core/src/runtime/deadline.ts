/** Chunk long deadlines so platform timeout overflow cannot cause early expiry. */
export function scheduleDeadline(deadline: number, action: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined,
    cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      action();
      return;
    }
    timer = setTimeout(schedule, Math.min(2 ** 31 - 1, remaining));
  };
  schedule();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
