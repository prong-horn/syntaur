/**
 * Semantic search seam — a stub provider for the future embeddings slot, plus
 * the `resolveProvider` resolver that returns the semantic provider only when
 * `--semantic` is set AND it's available, otherwise gracefully falls back to the
 * default `FuseProvider`. No embeddings are configured today, so
 * `SemanticProvider.isAvailable()` is always `false` and we always fall back.
 */

import type { SearchDoc, SearchHit, SearchProvider, SearchQuery } from './types.js';
import { FuseProvider } from './fuse-provider.js';

/** Thrown by the stub's `index`/`query` — the seam is not yet implemented. */
export class NotImplementedError extends Error {
  constructor(message = 'SemanticProvider is not implemented yet') {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export class SemanticProvider implements SearchProvider {
  /** No embeddings configured → never available in v1. */
  static isAvailable(): boolean {
    return false;
  }

  index(_docs: SearchDoc[]): void {
    throw new NotImplementedError();
  }

  query(_q: SearchQuery, _limit: number): SearchHit[] {
    throw new NotImplementedError();
  }
}

/**
 * Pick the search provider. Returns a `SemanticProvider` only when the caller
 * asked for `--semantic` AND it's actually available; otherwise the default
 * `FuseProvider`.
 */
export function resolveProvider(opts?: { semantic?: boolean }): SearchProvider {
  if (opts?.semantic && SemanticProvider.isAvailable()) {
    return new SemanticProvider();
  }
  return new FuseProvider();
}
