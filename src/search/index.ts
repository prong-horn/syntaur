/**
 * Barrel for the shared search core — re-exports everything the CLI
 * (`src/commands/search.ts`) and the dashboard (`src/dashboard/api-search.ts` +
 * palette) consume.
 */

export type {
  FileKind,
  SearchDoc,
  SearchHit,
  MatchRange,
  SearchQuery,
  SearchProvider,
} from './types.js';
export { FILE_KINDS, FILE_KIND_ALIASES, parseFileKinds } from './types.js';

export { FILE_KIND_TO_TAB, slugifyHeading, routeForHit } from './route.js';

export { buildIndex, getIndex, invalidateIndex } from './indexer.js';
export type { IndexOptions } from './indexer.js';

export { FuseProvider, extractSnippet, nearestSection } from './fuse-provider.js';
export type { SnippetResult } from './fuse-provider.js';

export { SemanticProvider, resolveProvider, NotImplementedError } from './semantic-provider.js';
