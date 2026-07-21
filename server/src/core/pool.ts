// @aso/core — bounded-concurrency worker pool. PROPRIETARY, pure.
//
// `width` runners pull from a shared cursor over `items` (deterministic item order). The FIRST
// error stops new dispatch — in-flight items settle, then that error is rethrown — so a
// control-flow error (client gone / pause / replay frontier / billing) tears a wave down cleanly
// without leaving orphan work. Live probing uses width>1 to keep the Apple client's queue full;
// replay uses width 1 for a deterministic frontier.

export async function runPool<T>(
  items: T[],
  width: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let aborted: unknown = null;
  const runner = async () => {
    for (;;) {
      if (aborted !== null) return;
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await worker(items[i], i);
      } catch (e) {
        if (aborted === null) aborted = e;
        return;
      }
    }
  };
  const runners = Math.max(1, Math.min(width, items.length));
  await Promise.all(Array.from({ length: runners }, () => runner()));
  if (aborted !== null) throw aborted;
}
