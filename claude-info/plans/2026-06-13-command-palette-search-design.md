# Design: Powerful Command Palette Search (Cmd+K) via AQL Reuse

- **Date:** 2026-06-13
- **Status:** Approved design (pre-implementation)
- **Author:** Brennen + Claude (brainstorming)

## Problem

The Cmd+K command palette is well-liked but limited:

1. **No filtering.** You can't narrow a search to one entity type or one property.
   Typing `payment` searches everything.
2. **Thin field coverage.** It matches title / subtitle / a small keywords list
   only (`dashboard/src/hotkeys/paletteIndex.ts`). The most-missed gap is
   **searching by Jira / external ID** — those IDs aren't in the index at all.
3. **Not customizable.** There's no way to express "only assignments", "this Jira
   ticket", or "tagged backend".

The user wants prefix-style filtering (`a:` assignments, `p:` projects,
`jira:PROJ-123`), property filters (tag / status / assignee / type), and external
IDs to be searchable.

## Key background discovery

Syntaur **already ships a query engine** — AQL (Assignment Query Language) — that
covers most of this:

- Module: `src/utils/query/` (`lexer.ts`, `parser.ts`, `ast.ts`, `evaluate.ts`,
  `fields.ts`, `index.ts`). Browser-safe (no Node deps), exported via the
  `@shared/query` alias and **already imported by the dashboard**
  (`dashboard/src/components/condition-editor-helpers.ts`).
- Public API: `compileQuery(input, registry) → { predicate: (item, ctx) => boolean, ast } | { errors }`.
- The **field registry is pluggable** (`ASSIGNMENT_FIELDS` is just the default).
  Field defs encode match semantics per `kind`: `enum` (equality), `string`
  (equality + `none` sentinel), `substring` (containment), `list` (membership),
  `bool`, `number`, `ordinal`, `timestamp`, `duration`.
- Grammar: `field:value`, `field:(a, b)` IN-lists, `-field:value` / `NOT`,
  comparisons, `AND`/`OR`/parens. Surfaced today on `ls --query` and the views page.
- A **bare word with no `:`** is a parse error in AQL — it is not free text.

`externalIds` (`{ system, id, url }`) is **already parsed**
(`src/dashboard/parser.ts` `parseExternalIds`) and surfaced onto the *detail*
objects (`ProjectDetail`, `AssignmentDetail` in `dashboard/src/hooks/useProjects.ts`,
served from `src/dashboard/api.ts`). It is **not** on the board *summaries*
(`ProjectSummary`, `AssignmentSummary`/`AssignmentBoardItem`) that feed the palette
index.

**Consequence:** the palette should *reuse AQL* as its filter layer rather than grow
a parallel `key:value` dialect. This is the central design decision.

## Goals

1. Filter the palette by entity type via short aliases: `a:` assignment,
   `p:` project, `t:` todo, `s:` server, `pb:` playbook.
2. Filter by property using AQL atoms that mean **exactly** what they mean on the
   views page / CLI: `status:`, `tag:`, `assignee:`, `type:`, plus negation `-`.
3. Search by external ID: `jira:PROJ-123` (and bare `PROJ-123` finds it too).
4. Keep the fast, forgiving free-text fuzzy ranking that makes the palette good.
5. Do this with maximum reuse and minimum new surface — no second query parser, no
   new settings page in v1.

## Non-goals (v1)

- **No settings UI / `/api/config/search`.** Ship good fixed defaults; revisit a
  config surface only if it's actually missed.
- **No chips/pills** in the input — raw text only (lowest risk).
- **No autocomplete** dropdown in v1 (AQL exposes positions to add it later).
- **No edit-distance / typo correction.** Filters use AQL's precise per-`kind`
  semantics; free text keeps the existing subsequence scorer (already more forgiving
  than substring). Fuse/bitap typo tolerance is explicitly deferred.
- **No full boolean palette queries** (`OR`, parenthesised groups, quoted
  multi-word values). The palette targets the implicit-AND-atoms + free-text common
  case; power users have the views page for complex boolean queries. (See
  "Query splitting" for exact v1 behavior.)

## Architecture — three layers, all reusing existing pieces

```
query string (palette input)
      │
      ▼
[1] Splitter  (new, ~thin)  reuses AQL lex() to classify tokens
      ├──► filter atoms  ─► [2] AQL compileQuery(PALETTE_FIELDS) ─► predicate (GATE)
      └──► free-text terms ─► [3] existing fuzzy rankAll() ───────► ranking (ORDER)
      ▼
gate ∘ rank → results
```

- **[1] Splitter** (new): `dashboard/src/hotkeys/paletteQuery.ts`. Separates the
  raw input into an AQL sub-expression (filter atoms) and free-text terms, and
  expands type-alias sugar.
- **[2] Filter gate**: `compileQuery(aqlExpr, PALETTE_FIELDS)` from `@shared/query`
  — no new engine. Predicate filters the index entries.
- **[3] Ranking**: the existing `rankAll()` / `scoreField()` in
  `dashboard/src/hotkeys/fuzzy.ts`, unchanged, scoring the free-text terms over the
  surviving entries.

### Why this shape

- **One grammar everywhere.** `status:`, `tag:`, `assignee:`, `type:`, `-neg`
  behave identically in the palette, `ls --query`, and the views page.
- **Filters precise, ranking forgiving.** Exactly the right split: a filter is a
  yes/no gate (AQL `kind` semantics); relevance ordering is fuzzy (subsequence).
- **Add a field once, get it everywhere.** Registering `jira`/`externalId` lights
  it up for the palette and (optionally) the CLI/views page.

---

## Piece 1 — Query splitting (`paletteQuery.ts`)

`splitPaletteQuery(input) → { aqlExpr: string; fuzzy: string }`

Algorithm (reuses `lex()` from `@shared/query`):

1. **Expand type-alias sugar first.** A leading or whitespace-delimited token of the
   form `<alias>:` or `<alias>:<glued>` where `<alias> ∈ { a, p, t, s, pb }` becomes
   a canonical `kind:<entityType>` atom; any glued value (`a:payment`) is split off
   into the free-text stream. Aliases are a small palette-level map; everything else
   is a plain registry field handed straight to AQL.
2. **Classify remaining tokens.** Walk AQL tokens. A run that forms an atom —
   `IDENT COLON valueOrList`, `IDENT OP value`, optionally preceded by `MINUS`/`NOT`,
   plus `(`/`)`/`AND`/`OR` — is a **filter atom**, *only if* the `IDENT`
   (lowercased) resolves in `PALETTE_FIELDS`. A bare `IDENT` (or an unknown
   `foo:bar`) is **free text** and rejoined into `fuzzy`.
   - Rationale for the registry check: an unknown `foo:bar` must stay literal so a
     title containing a colon still searches, and so half-typed input degrades
     gracefully.
3. **Leniency for in-progress typing.** A trailing token that does not yet form a
   valid atom (e.g. `status:` mid-type) is treated as free text until it parses.
   The splitter never produces an `aqlExpr` that fails `compileQuery`; if it
   somehow does, the consumer ignores the bad atom and falls back to free-text-only.

v1 scope of the splitter: implicit-AND atoms + free text (the 95% case). If the
input contains explicit `OR` / parentheses, treat the **entire** input as an AQL
expression with no free-text fuzzy (it still gates; ordering falls back to default).
Quoted multi-word values are supported for atoms (the AQL lexer already produces
`STRING` tokens) but are not required for v1.

**Output is deterministic and pure** — trivially unit-testable.

## Piece 2 — Palette field registry (`PALETTE_FIELDS`)

A `FieldRegistry` (the same type AQL already exports) curated for the palette's
multi-entity index. Lives next to the splitter (`paletteQuery.ts`) or
`paletteIndex.ts`.

| Field | kind | accessor / notes |
|---|---|---|
| `kind` | enum | `i => i.type` — entity type (`assignment`/`project`/`todo`/`server`/`playbook`/`page`). Target of the `a:`/`p:`/… aliases. |
| `status` | enum | assignment/todo status (undefined for pages/servers ⇒ excluded by a `status:` atom, which is correct) |
| `tag` / `tags` | list | membership over the entry's tags |
| `assignee` | string | `noneSentinel: true` |
| `type` | enum | the assignment's own `type` field (distinct from `kind`) |
| `project` | string | project slug; `noneSentinel: true` for standalone |
| `externalid` | substring | flattened `"system:id"` haystack over the entry's externalIds |
| `jira` | substring | external IDs filtered to `system === 'jira'` |
| `title` / `search` | substring | parity with AQL's `search` field if useful for explicit `title:` atoms |

Atoms referencing a field an entity doesn't have evaluate to `false` for that entity
— so `status:done` naturally narrows to assignments/todos, and `jira:X` to entities
carrying external IDs. No special multi-entity casing needed.

`gh:` (github) and a generic `externalid:` are cheap bonus aliases/fields if wanted.

## Piece 3 — Surface `externalIds` onto board summaries + index

The one backend/data touch. `externalIds` is already parsed; this is projection +
plumbing, not new parsing.

1. **Summary types** (`dashboard/src/hooks/useProjects.ts`): add
   `externalIds: ExternalIdInfo[]` to `ProjectSummary` and `AssignmentSummary`
   (inherited by `AssignmentBoardItem`).
2. **Server board builders** (`src/dashboard/types.ts` summary types +
   `src/dashboard/api.ts` list/board endpoints): include `externalIds` in the
   summary projections (the detail builders at `api.ts:1217/1346/1686` already do
   this; mirror onto the list builders). Pin exact functions during planning.
3. **Index** (`dashboard/src/hotkeys/paletteIndex.ts`): in `buildIndex`, enrich
   project/assignment entries with the filterable fields the registry reads —
   `status`, `tags`, `assignee`, `project`, and a flattened `externalIds`. Also fold
   external IDs into the entry's fuzzy-searchable `keywords` (default-on) so a bare
   `PROJ-123` query finds the item without a prefix.

### Recommended companion (separable)

Register `jira`/`externalId` in `ASSIGNMENT_FIELDS` (`src/utils/query/fields.ts`)
and include `externalIds` in the QueryItem materialized by the `ls`/views loaders,
so `syntaur ls --query jira:PROJ-123` and the views page gain external-ID filtering
too. This is orthogonal to the palette and can ship as its own small follow-up; the
palette does not depend on it.

## Piece 4 — Palette wiring & UX

`CommandPalette.tsx` / `HotkeyProvider.tsx`:

1. On query change: `splitPaletteQuery(query)` → `{ aqlExpr, fuzzy }`.
2. If `aqlExpr`: `compileQuery(aqlExpr, PALETTE_FIELDS)` → predicate; filter the
   index. (Memoise the compiled predicate on `aqlExpr`.)
3. `rankAll(fuzzy, survivors, 50)` as today. When `fuzzy` is empty (pure filter,
   e.g. `a:`), show survivors in the existing default order (type priority / title)
   — this gives a useful "list all assignments" behavior.

UX (raw text, no chips):

- **Placeholder** hints at the syntax: e.g. `Search… try a:  p:  jira:PROJ-123  tag:backend`.
- **Empty state** shows a compact legend of available prefixes instead of "Start
  typing to search".
- **Active-filters line** under the input summarising the parsed gate
  (e.g. `assignment · jira:PROJ-123`) so it's visible what's being applied vs.
  fuzzy-matched.
- **No-match** copy unchanged.

---

## Build sequence

1. **Splitter + `PALETTE_FIELDS`** (`paletteQuery.ts`) — pure, heavily unit-tested,
   no UI. Includes alias expansion and the registry-membership rule.
2. **Surface `externalIds`** onto summaries + server builders + `buildIndex`
   enrichment (Piece 3).
3. **Wire the palette** — split → gate → rank in `CommandPalette` (Piece 4 logic).
4. **UX polish** — placeholder, legend, active-filters line.
5. *(Optional follow-up)* `jira`/`externalId` in `ASSIGNMENT_FIELDS` + loader
   QueryItem, for CLI/views parity.

## Testing

- **Splitter** (pure): alias expansion (`a:`, `a:payment`, `p:`), atom vs free-text
  classification, unknown-field passthrough (`foo:bar` stays fuzzy), trailing
  in-progress token leniency, negation, IN-lists, the explicit-boolean → pure-AQL
  fallback.
- **Gate + rank integration**: `status:done` excludes pages/servers; `jira:X`
  narrows to entities with that external ID; `a: payment` = assignments fuzzy-ranked
  by "payment"; pure `a:` lists assignments in default order; bare `PROJ-123` finds
  the item via keywords.
- **Data plumbing**: summaries carry `externalIds`; `buildIndex` enriches entries;
  extend the existing `dashboard-api` summary fixtures/tests.
- Existing `fuzzy.test.ts` stays green (scorer unchanged) and is extended for the
  external-ID keyword.
- Verify: root `npm run typecheck` + targeted Vitest; `cd dashboard && npx tsc
  --noEmit && npm run build`.

## Key trade-offs / accepted limitations

- Palette filters are precise (AQL `kind` semantics), not fuzzy — intentional;
  forgiveness lives in the free-text ranker.
- `status:in` won't match `in_progress` mid-type (enum equality). Mitigated by
  treating not-yet-valid trailing tokens as free text; autocomplete (deferred) would
  close the gap fully.
- No `OR`/grouping in the palette v1 (full boolean lives on the views page).
- External-ID search depends on entities actually declaring `externalIds` in
  frontmatter.

## Decisions locked during brainstorming

1. **Reuse AQL** as the filter layer (not a bespoke palette grammar).
2. **`p:` → projects** (type alias); aliases desugar to `kind:<type>`.
3. **Filter set:** external-ID/`jira`, `tag`, `status`, `assignee`, `type` — via AQL
   atoms.
4. **Match semantics:** AQL per-`kind` for filters; existing subsequence fuzzy for
   free text; edit-distance/Fuse deferred.
5. **Config:** defaults only in v1; no settings UI / `/api/config/search`.
6. **Input UX:** raw text + legend + active-filters line; chips deferred.
