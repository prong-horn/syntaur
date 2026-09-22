/** Poll until `predicate` is true; throws if `timeoutMs` elapses (predicate throws count as not ready). */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
  pollMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      /* predicate not ready yet */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}
