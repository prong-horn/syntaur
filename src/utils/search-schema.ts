/**
 * Search-config schema — the shape behind the `search:` block in
 * `~/.syntaur/config.md` and the command palette's customizable behavior.
 *
 * Browser-safe: no Node-only imports. Consumed by both the server
 * (`src/dashboard/api-search-config.ts`, `src/utils/config.ts`) and the SPA
 * (via the `@shared/search-schema` alias) so palette aliases, default scope, and
 * external-ID indexing validate against ONE source of truth.
 *
 * See `claude-info/plans/2026-06-15-command-palette-ui-design.md`.
 */

/** The five searchable entity kinds an alias prefix can target. */
export type EntityKind = 'assignment' | 'project' | 'todo' | 'server' | 'playbook';

export const ENTITY_KINDS: readonly EntityKind[] = [
  'assignment',
  'project',
  'todo',
  'server',
  'playbook',
];

/** Default search scope: `all` (everything) or one entity kind. */
export type DefaultScope = 'all' | EntityKind;

export interface SearchConfig {
  /** With no explicit type prefix, inject an implicit `kind:<scope>` gate. `all` = no gate. */
  defaultScope: DefaultScope;
  /** Prefix → entity kind. Replaces the hardcoded palette `TYPE_ALIASES`. */
  aliases: Record<string, EntityKind>;
  /** Fold external IDs into the index + enable `jira:`/`externalid:`/bare-ID matching. */
  externalIds: boolean;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  defaultScope: 'all',
  aliases: { a: 'assignment', p: 'project', t: 'todo', s: 'server', pb: 'playbook' },
  externalIds: true,
};

/**
 * Palette AQL field names an alias prefix may NOT shadow (mirrors the keys of
 * `PALETTE_FIELDS` in `dashboard/src/hotkeys/paletteQuery.ts`). Declared here —
 * browser-safe and dependency-free — so the server router and the live SPA
 * validation share exactly one collision set (the server cannot import dashboard
 * code). Keep in sync with `PALETTE_FIELDS`.
 */
export const SEARCH_FIELD_NAMES: readonly string[] = [
  'kind',
  'status',
  'tag',
  'tags',
  'assignee',
  'type',
  'project',
  'externalid',
  'jira',
  'title',
  'search',
];

/** Reserved escape prefix — `all:` searches everything; disallowed as a custom alias. */
export const RESERVED_ALIAS = 'all';

/** An alias key must be lowercase, start with a letter, then letters/digits. */
const ALIAS_KEY_RE = /^[a-z][a-z0-9]*$/;

function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value);
}

function isDefaultScope(value: unknown): value is DefaultScope {
  return value === 'all' || isEntityKind(value);
}

/**
 * Coerce an arbitrary parsed object into a valid `SearchConfig`, filling defaults
 * for missing/invalid fields. Lenient (read/persist path): invalid alias entries
 * are dropped rather than rejected — the strict gate is `validateAliases`, used by
 * the POST router. An explicitly-present-but-empty `aliases` map stays empty; a
 * missing `aliases` falls back to the defaults.
 */
export function normalizeSearchConfig(raw: unknown): SearchConfig {
  if (!raw || typeof raw !== 'object') {
    return cloneDefaultSearchConfig();
  }
  const r = raw as Record<string, unknown>;

  const defaultScope: DefaultScope = isDefaultScope(r['defaultScope'])
    ? r['defaultScope']
    : DEFAULT_SEARCH_CONFIG.defaultScope;

  const externalIds =
    typeof r['externalIds'] === 'boolean'
      ? r['externalIds']
      : DEFAULT_SEARCH_CONFIG.externalIds;

  let aliases: Record<string, EntityKind>;
  if (r['aliases'] && typeof r['aliases'] === 'object') {
    aliases = {};
    for (const [key, value] of Object.entries(r['aliases'] as Record<string, unknown>)) {
      if (
        ALIAS_KEY_RE.test(key) &&
        key !== RESERVED_ALIAS &&
        !SEARCH_FIELD_NAMES.includes(key) &&
        isEntityKind(value)
      ) {
        aliases[key] = value;
      }
    }
  } else {
    aliases = { ...DEFAULT_SEARCH_CONFIG.aliases };
  }

  return { defaultScope, aliases, externalIds };
}

/**
 * Strict alias validation (POST path). Each key must be lowercase `[a-z][a-z0-9]*`,
 * must not be the reserved `all`, must not collide with a `SEARCH_FIELD_NAMES`
 * member, and must map to one of the five entity kinds. Returns every violation so
 * the router can 400 with the full list and the SPA can show inline feedback.
 */
export function validateAliases(
  aliases: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  if (!aliases || typeof aliases !== 'object') {
    return { ok: false, errors: ['aliases must be an object'] };
  }
  const errors: string[] = [];
  for (const [key, value] of Object.entries(aliases as Record<string, unknown>)) {
    if (!ALIAS_KEY_RE.test(key)) {
      errors.push(`alias key "${key}" must be lowercase and match [a-z][a-z0-9]*`);
    }
    if (key === RESERVED_ALIAS) {
      errors.push(`alias key "${RESERVED_ALIAS}" is reserved (the "search everything" escape)`);
    }
    if (SEARCH_FIELD_NAMES.includes(key)) {
      errors.push(`alias key "${key}" collides with the reserved field name "${key}"`);
    }
    if (!isEntityKind(value)) {
      errors.push(`alias "${key}" must map to one of: ${ENTITY_KINDS.join(', ')}`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Validate a default-scope value (POST path). */
export function isValidDefaultScope(value: unknown): value is DefaultScope {
  return isDefaultScope(value);
}

function cloneDefaultSearchConfig(): SearchConfig {
  return {
    defaultScope: DEFAULT_SEARCH_CONFIG.defaultScope,
    aliases: { ...DEFAULT_SEARCH_CONFIG.aliases },
    externalIds: DEFAULT_SEARCH_CONFIG.externalIds,
  };
}
