// A guard for a screen that reads the same thing again and again (the top bar's safety pill reads the gate
// every 5 s, and one read may wait up to 10 s). Two rules keep an old answer from landing over a newer one:
//   - one read at a time: a poll that arrives while a read is still waiting does not start another;
//   - newest read wins: each read gets a number, and only the newest may update the screen. `cancel()` makes
//     whatever is in flight old (the screen is gone, or asks again), so its answer is dropped.
// No imports, so the tests can load it straight from src/ with Node.

export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function createLatestRead() {
  let newest = 0;
  let running = false;
  return {
    // Reads, then hands the outcome (the answer, or why it failed) to `apply`, unless a newer read or a
    // cancel came first. Returns false, and does nothing, when a read is already waiting.
    async run<T>(read: () => Promise<T>, apply: (outcome: ReadOutcome<T>) => void): Promise<boolean> {
      if (running) return false;
      running = true;
      const mine = (newest += 1);
      let outcome: ReadOutcome<T>;
      try {
        outcome = { ok: true, value: await read() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      // Only the newest read frees the guard and may update the screen: an old one that ends late must
      // leave the newer read's guard alone.
      if (mine === newest) {
        running = false;
        apply(outcome);
      }
      return true;
    },
    // Whatever is in flight no longer counts, and a new read may start at once.
    cancel() {
      newest += 1;
      running = false;
    }
  };
}
