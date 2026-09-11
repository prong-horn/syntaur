const writeLocks = new Map<string, Promise<void>>();

export function withLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(lockKey) ?? Promise.resolve();
  const next = prev.then(fn);
  writeLocks.set(
    lockKey,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}
