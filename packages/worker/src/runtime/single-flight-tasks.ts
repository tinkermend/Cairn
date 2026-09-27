/** Keep independent periodic jobs from waiting on each other within a worker role. */
export class SingleFlightTasks<Key extends string> {
  private readonly running = new Map<Key, Promise<void>>();
  private closed = false;

  start(
    key: Key,
    run: () => Promise<unknown> | unknown,
    onError: (error: unknown) => void,
  ): boolean {
    if (this.closed || this.running.has(key)) return false;

    // Schedule the callback after the key is registered. A synchronous throw is
    // handled in the same way as a rejected promise.
    const task = Promise.resolve()
      .then(run)
      .then(() => undefined)
      .catch((error: unknown) => {
        onError(error);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.running.get(key) === task) this.running.delete(key);
      });
    this.running.set(key, task);
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.running.values());
  }
}
