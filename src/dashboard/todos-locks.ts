// Shared write-lock map for the todo routers. Both the workspace router
// (api-todos.ts) and the project router (api-project-todos.ts) acquire from
// this same Map so cross-scope move can hold both source and target locks
// in lexical order of the prefixed key without risk of deadlock.
//
// Lock-key prefixes:
//   ws:<workspace>   — workspace-scoped checklist
//   proj:<slug>      — project-scoped checklist
//   global:          — the singleton global checklist
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

export function wsLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`ws:${workspace}`, fn);
}

export function projLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`proj:${slug}`, fn);
}

export function globalLockKey(): string {
  return 'global:';
}

// Acquire two locks in lexical order to prevent deadlock when one request
// needs to mutate two scopes (e.g. cross-scope todo move).
export function withTwoLocks<T>(
  keyA: string,
  keyB: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (keyA === keyB) return withLock(keyA, fn);
  const [first, second] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
  return withLock(first, () => withLock(second, fn));
}
