# Design: Command Palette Autocomplete + Search Settings UI

- **Date:** 2026-06-15
- **Status:** Approved design (pre-implementation)
- **Author:** Brennen + Claude (brainstorming)
- **Builds on:** `claude-info/plans/2026-06-13-command-palette-search-design.md` (the shipped AQL palette search, `v0.54.0`)

## Problem

The AQL-powered Cmd+K palette (shipped `v0.54.0`) is powerful but undiscoverable
and uncustomizable. Two v1 non-goals are now wanted:

1. **No autocomplete.** You must already know the syntax (`a:`, `status:open`,
   `jira:PROJ-123`). Nothing suggests prefixes, fields, or values as you type.
2. **No settings.** The type-alias prefixes, the default search scope, and
   external-ID indexing are all hardcoded; there is no UI to change them.

## Scope

One assignment, built in 5 stages (below). Covers two cohesive features that share
a single new search-config object:

- **A. Search settings** — a `search:` block in `~/.syntaur/config.md`, a
  `/api/config/search` router, a `useSearchConfig` hook, and a "Search" section on
  the Settings page.
- **B. Autocomplete** — a pure suggestion engine over the AQL lexer, plus a
  suggestions dropdown in `CommandPalette` (raw-text input retained; **no chips**).

## Non-goals

- **No chips/pills** input — raw text + dropdown only (user decision).
- **No fuzzy / typo-tolerance** knobs — explicitly out (filters stay precise via
  AQL, ranking stays subsequence-based).
- **No Views-page external-ID filter** — that stretch (registering `jira`/`externalid`
  in `ASSIGNMENT_FIELDS` + `ls`/views loaders) is a separate, deferred follow-up.
- **No autocomplete for boolean/grouped queries** (`OR`, parens) — those route
  whole-string to AQL today and stay that way; suggestions target the
  implicit-AND token walk only.

---

## Part A — Search settings

### Config shape

New `search:` block in `~/.syntaur/config.md`. Workspace-level (survives across
browsers / machines), consistent with every sibling setting — **not** localStorage.

```yaml
search:
  defaultScope: all          # all | assignment | project | todo | server | playbook
  aliases:                   # prefix -> entity kind
    a: assignment
    p: project
    t: todo
    s: server
    pb: playbook
  externalIds: true          # fold external IDs into the index + enable jira:/bare-ID
```

**Semantics**

- `defaultScope`: when a query has **no** explicit type prefix, inject an implicit
  `kind:<scope>` atom into the gate. An explicit prefix (`p:`) overrides it.
  Escape hatch: an `all:` prefix (reserved alias) — or an empty box — searches
  everything regardless of `defaultScope`.
- `aliases`: replaces the hardcoded `TYPE_ALIASES` in `paletteQuery.ts`. Validation:
  each key lowercase, non-empty, `[a-z][a-z0-9]*`, must NOT collide with a registry
  field name (`kind`, `status`, `tag`, `tags`, `assignee`, `type`, `project`,
  `externalid`, `jira`, `title`, `search`) nor with the reserved `all`. Each value
  must be one of the five entity kinds.
- `externalIds`: when `false`, `paletteIndex.ts` stops folding external IDs into the
  fuzzy keyword text, and `jira:`/`externalid:`/bare-ID matching is suppressed
  (those fields drop out of suggestions too).

### New / changed files (Part A)

- **New** `src/shared/search-schema.ts` — `SearchConfig` type, `DEFAULT_SEARCH_CONFIG`,
  `normalizeSearchConfig(raw): SearchConfig`, and `validateAliases(...)`. Browser-safe
  (imported by both server and dashboard via the `@shared` alias).
- **New** `src/dashboard/api-search-config.ts` — `createSearchConfigRouter()`:
  `GET /api/config/search`, `POST` (validate + persist), `DELETE` (reset to default).
  Reads/writes the `search:` block through `src/utils/config.ts` (add
  `readSearchConfig` / `updateSearchConfig` there, mirroring the status/terminal
  helpers). Mounted in `src/dashboard/server.ts` at `/api/config/search`.
- **New** `dashboard/src/hooks/useSearchConfig.ts` — module-cached hook mirroring
  `useTerminalConfig` (`fetch`/`save`/`reset`/`invalidate` + subscriber set).
- **Changed** `dashboard/src/pages/SettingsPage.tsx` (+ `settings-page-helpers.ts`)
  — a "Search" section: default-scope select, alias editor (add/rename/remove/remap
  rows with inline validation), external-IDs toggle, Reset-to-defaults.
- **Changed** `src/dashboard/watcher.ts` — the existing config.md watcher already
  triggers recompute on change; confirm the search block participates (no recompute
  needed — palette reads config client-side — but invalidate the client cache on
  the config.md change signal if such a channel exists; otherwise the hook re-fetches
  on next palette open).

---

## Part B — Autocomplete

### Suggestion engine (pure)

**New** `dashboard/src/hotkeys/paletteSuggest.ts`. Reuses the AQL `lex` + token
positions already used by `splitPaletteQuery` — no second parser.

```ts
interface SuggestContext {
  aliases: Record<string, EntityKind>;   // from config
  fields: string[];                       // PALETTE_FIELDS keys (minus jira/externalid when externalIds=false)
  values: {                               // value sources for the token after `field:`
    status: string[];                     // from useStatusConfig
    type: string[];                       // from useTypesConfig
    tag: string[];                        // derived from loaded entries
    assignee: string[];                   // derived from loaded entries
    externalid: string[];                 // derived from loaded entries (when enabled)
  };
}
interface Suggestion { label: string; insert: string; replace: [start: number, end: number]; kind: 'prefix' | 'field' | 'value'; }

function suggestPalette(input: string, caret: number, ctx: SuggestContext): Suggestion[];
```

**Categories (token under the caret)**

- **Start of input / a bare-word token** → alias prefixes (`a:`…) + field names
  (`status:`…), filtered by the typed fragment.
- **A value position immediately after `field:`** → values for that field from
  `ctx.values` (enum/list fields); free-form fields (`title`, `search`) yield none.
- A complete, already-valid atom under the caret → no suggestions (don't nag).
- Half-typed / unlexable input degrades to no suggestions (never throws) — same
  resilience contract as `splitPaletteQuery`.

`replace` is the exact source span of the token being completed, so accepting a
suggestion never corrupts the rest of the query (quoted values, IN-lists included).

### Dropdown UI + keyboard

**Changed** `dashboard/src/hotkeys/CommandPalette.tsx`:

- Render a suggestions dropdown overlay anchored under the input when
  `suggestions.length > 0` and the input is focused. Highlight index `0` by default.
- **Keyboard** (dropdown open): `Tab` / `→` accept highlighted suggestion (splice
  `insert` into `replace` span, move caret to end of insert); `↑`/`↓` move the
  suggestion highlight; `Esc` closes the dropdown only. **Dropdown closed:** `↑`/`↓`
  navigate the results list and `Esc` closes the palette (today's behavior). `Enter`
  always opens the selected result (accepting a suggestion is `Tab`/`→`, never `Enter`,
  to preserve fast open).
- Mouse: click a suggestion to accept; hover to highlight.
- The active-filters line ("Filtering …") and empty-state legend stay.

### Config wiring into the gate

**Changed** `dashboard/src/hotkeys/paletteQuery.ts`:

- `TYPE_ALIASES` becomes a parameter sourced from config (default-export the
  hardcoded map as the fallback). `splitPaletteQuery(input, aliases?)` and the
  alias-expansion helper take the map.
- Default-scope injection: after splitting, if no `kind:` atom is present in the
  gate and `defaultScope !== 'all'` and the input is not the `all:` escape, prepend
  `kind:<scope>`.

**Changed** `dashboard/src/hotkeys/paletteIndex.ts`: gate external-ID folding on
`config.externalIds`.

---

## Build order (one assignment, 5 stages)

1. **Search config backend** — `search-schema.ts`, `utils/config.ts` helpers,
   `api-search-config.ts`, mount in `server.ts`. Unit + router tests.
2. **Wire config into the palette gate** — config-driven aliases, default-scope
   injection, external-ID toggle in index. Unit tests for the new split params.
3. **Settings page "Search" section** — `useSearchConfig.ts` + UI + validation.
4. **Suggestion engine** — `paletteSuggest.ts`, pure + thoroughly unit-tested
   (categories, span correctness, resilience).
5. **Dropdown UI + keyboard** — `CommandPalette.tsx` integration.

## Testing

- **Pure units** (vitest): `paletteSuggest` (every category, replace-span fidelity,
  unlexable/half-typed resilience), config-driven `splitPaletteQuery` (custom
  aliases, default-scope injection + `all:` escape), `search-schema` normalize/validate.
- **Router** (backend): `/api/config/search` GET/POST/DELETE round-trip, alias
  validation rejection, config.md persistence.
- **Gates:** root `npm run typecheck`; `npm run build --prefix dashboard`; dashboard
  vitest; backend `npm test`.

## Open questions

None blocking. (`all:` is chosen as the reserved "search everything" escape; it is
disallowed as a custom alias key.)
