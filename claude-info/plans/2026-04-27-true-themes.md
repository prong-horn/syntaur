# Make themes a true theme (tinted neutrals + theme-aware status colors)

## Context

The dashboard added a theme system (`default` / `ocean` / `forest` / `sunset`) but switching presets only shifts accent colors (primary, secondary, coral, teal, amber). The dark backgrounds, cards, sidebar, borders, button surfaces, status badges, code blocks, and feedback banners stay identical across presets — so themes feel like a no-op besides a few hue shifts. The user wants each preset to feel meaningfully different.

The fix has two parts:
1. **Tint the neutrals per preset.** Today only ~9 brand tokens are overridden per preset. Extend each preset to override the full neutral palette (background, card, popover, muted, accent, border, input, sidebar) with subtle hue/chroma shifts so each preset has its own personality (cool blue, cool green, warm orange) while staying usable.
2. **Wire hardcoded color classes to theme tokens.** Status badges, progress bar segments, code blocks, mobile overlay, success/error banners currently use raw Tailwind palette classes (`bg-slate-950`, `bg-violet-100`, `bg-emerald-50`, etc.) that bypass the theme system. Move these to CSS-variable-driven tokens so the entire UI participates in theming.

## Files to modify

- `dashboard/src/globals.css` — main change; extend presets with neutral overrides, add status/feedback/code tokens, fix `.prose-syntaur` hardcoded slate
- `dashboard/tailwind.config.ts` — register new token families (`status-*`, `success`, `error`, `warning`, `info`, `code-bg/fg`, `overlay`)
- `dashboard/src/components/StatusBadge.tsx` — replace hardcoded classes in `STATUS_META` with theme tokens
- `dashboard/src/components/ProgressBar.tsx` — replace `DEFAULT_SEGMENT_COLORS` and `FALLBACK_COLORS` with status tokens
- `dashboard/src/components/CommandSnippet.tsx` — replace `bg-slate-950 text-slate-100` with `bg-code text-code-foreground`
- `dashboard/src/components/AppShell.tsx` — replace `bg-slate-950/40` mobile overlay with `bg-overlay/40`
- `dashboard/src/components/ColorPicker.tsx` — replace the `#64748b` hex placeholder with a token-derived value (or drop it)
- `dashboard/src/pages/SettingsPage.tsx` — replace inline emerald/rose feedback banners with `bg-success/20 text-success-foreground` etc.
- `dashboard/src/pages/ProjectDetail.tsx` — replace the one `border-amber-300 text-amber-700` instance with `border-warning text-warning-foreground`

## Step 1 — Extend `globals.css` presets with neutral tints

Each preset gets its own `:root[data-theme=...]` and `.dark[data-theme=...]` block that overrides the full neutral palette. Hue follows the preset identity; chroma stays low (0.008–0.020) so surfaces look tinted, not colored.

Approximate hue map (OKLCH hue degrees):

| Preset  | Hue | Identity          |
|---------|-----|-------------------|
| default | 280 | cool purple (current) |
| ocean   | 230 | cool blue         |
| forest  | 155 | cool green        |
| sunset  | 35  | warm orange-brown |

For each preset, override these tokens in the `.dark[data-theme='X']` block (and lighter equivalents in `:root[data-theme='X']`):
- `--background`, `--foreground`
- `--card`, `--card-foreground`, `--popover`, `--popover-foreground`
- `--muted`, `--muted-foreground`
- `--accent`, `--accent-foreground`
- `--border`, `--input`
- `--sidebar`

Example shape (dark + ocean):
```css
.dark[data-theme='ocean'] {
  --background: 9% 0.014 230;
  --foreground: 95% 0.008 230;
  --card: 14% 0.014 230;
  --popover: 14% 0.014 230;
  --muted: 18% 0.016 230;
  --accent: 18% 0.016 230;
  --border: 24% 0.014 230;
  --input: 24% 0.014 230;
  --sidebar: 7% 0.014 230;
  /* existing brand tokens stay as-is */
}
```

Default preset already lives in the bare `:root` and `.dark` rules; leave those as-is so `data-theme="default"` (and absent attribute) keep current look. Do this for ocean, forest, sunset only.

Also update the dark-mode body radial gradient (currently `oklch(22% 0.008 280)` hardcoded at line 124) to use a CSS variable so its dot color tracks the theme — introduce `--dot-grid: 22% 0.008 280` in `:root`/`.dark` and override per preset, then change `background-image: radial-gradient(circle, oklch(var(--dot-grid)) 1px, ...)`.

## Step 2 — Add status/feedback/code tokens to `globals.css`

Add to `:root` (light) and `.dark`:

```css
/* Status colors — light */
--status-pending: 90% 0.005 280;          /* surface bg */
--status-pending-foreground: 35% 0.01 280;
--status-in-progress: 92% 0.05 290;
--status-in-progress-foreground: 35% 0.15 290;
--status-blocked: 92% 0.05 15;
--status-blocked-foreground: 40% 0.15 15;
--status-review: 92% 0.06 75;
--status-review-foreground: 40% 0.15 75;
--status-completed: 92% 0.05 175;
--status-completed-foreground: 38% 0.12 175;
--status-failed: 92% 0.06 25;
--status-failed-foreground: 42% 0.18 25;
--status-archived: 90% 0.003 280;
--status-archived-foreground: 38% 0.005 280;

/* Feedback */
--success: 90% 0.06 160;
--success-foreground: 35% 0.12 160;
--warning: 92% 0.06 75;
--warning-foreground: 40% 0.15 75;
--error: 92% 0.06 25;
--error-foreground: 42% 0.18 25;
--info: 92% 0.05 230;
--info-foreground: 38% 0.13 230;

/* Code blocks */
--code: 96% 0.005 280;
--code-foreground: 25% 0.008 280;

/* Modal/scrim overlay (always near-black regardless of theme) */
--overlay: 4% 0.005 280;
```

And mirrored values in `.dark` (lower lightness backgrounds, higher lightness text):

```css
--status-pending: 18% 0.005 280;
--status-pending-foreground: 75% 0.005 280;
--status-in-progress: 22% 0.05 290;
--status-in-progress-foreground: 80% 0.10 290;
/* ...etc... */
--code: 12% 0.008 280;
--code-foreground: 92% 0.005 280;
--overlay: 0% 0 0;
```

Status tokens stay universal (not per-preset) — semantic meaning (red=failed, green=success) is invariant. The light/dark variants are the only split.

Update `.prose-syntaur` rules (lines 171–177):
```css
.prose-syntaur :where(code):not(:where(pre code)) {
  @apply rounded-md bg-muted px-1.5 py-0.5 text-[0.9em] text-foreground;
}
.prose-syntaur pre {
  @apply rounded-lg border border-border/60 bg-code px-3 py-3 text-code-foreground;
}
```

## Step 3 — Register tokens in `tailwind.config.ts`

Extend `theme.extend.colors`:

```ts
overlay: 'oklch(var(--overlay) / <alpha-value>)',
code: {
  DEFAULT: 'oklch(var(--code) / <alpha-value>)',
  foreground: 'oklch(var(--code-foreground) / <alpha-value>)',
},
status: {
  pending: { DEFAULT: 'oklch(var(--status-pending) / <alpha-value>)', foreground: 'oklch(var(--status-pending-foreground) / <alpha-value>)' },
  'in-progress': { DEFAULT: 'oklch(var(--status-in-progress) / <alpha-value>)', foreground: 'oklch(var(--status-in-progress-foreground) / <alpha-value>)' },
  blocked: { DEFAULT: 'oklch(var(--status-blocked) / <alpha-value>)', foreground: 'oklch(var(--status-blocked-foreground) / <alpha-value>)' },
  review: { DEFAULT: 'oklch(var(--status-review) / <alpha-value>)', foreground: 'oklch(var(--status-review-foreground) / <alpha-value>)' },
  completed: { DEFAULT: 'oklch(var(--status-completed) / <alpha-value>)', foreground: 'oklch(var(--status-completed-foreground) / <alpha-value>)' },
  failed: { DEFAULT: 'oklch(var(--status-failed) / <alpha-value>)', foreground: 'oklch(var(--status-failed-foreground) / <alpha-value>)' },
  archived: { DEFAULT: 'oklch(var(--status-archived) / <alpha-value>)', foreground: 'oklch(var(--status-archived-foreground) / <alpha-value>)' },
},
success: {
  DEFAULT: 'oklch(var(--success) / <alpha-value>)',
  foreground: 'oklch(var(--success-foreground) / <alpha-value>)',
},
warning: {
  DEFAULT: 'oklch(var(--warning) / <alpha-value>)',
  foreground: 'oklch(var(--warning-foreground) / <alpha-value>)',
},
error: {
  DEFAULT: 'oklch(var(--error) / <alpha-value>)',
  foreground: 'oklch(var(--error-foreground) / <alpha-value>)',
},
info: {
  DEFAULT: 'oklch(var(--info) / <alpha-value>)',
  foreground: 'oklch(var(--info-foreground) / <alpha-value>)',
},
```

## Step 4 — Refactor `StatusBadge.tsx`

Replace each `className` in `STATUS_META`:
- pending → `'border-status-pending bg-status-pending text-status-pending-foreground'`
- in_progress / active → `'border-status-in-progress bg-status-in-progress text-status-in-progress-foreground'`
- blocked → `'border-status-blocked bg-status-blocked text-status-blocked-foreground'`
- review → `'border-status-review bg-status-review text-status-review-foreground'`
- completed → `'border-status-completed bg-status-completed text-status-completed-foreground'`
- failed → `'border-status-failed bg-status-failed text-status-failed-foreground'`
- stopped → reuse pending tokens
- archived → `'border-status-archived bg-status-archived text-status-archived-foreground'`
- fallback (line 85) → reuse pending tokens

Borders look better one shade darker — use `border-status-pending/70` etc. if needed (apply uniformly).

## Step 5 — Refactor `ProgressBar.tsx`

Lines 7–23 — replace the maps:

```ts
const DEFAULT_SEGMENT_COLORS: Record<string, string> = {
  completed: 'bg-status-completed-foreground',
  in_progress: 'bg-status-in-progress-foreground',
  review: 'bg-status-review-foreground',
  blocked: 'bg-status-blocked-foreground',
  failed: 'bg-status-failed-foreground',
  pending: 'bg-status-pending-foreground',
};

const FALLBACK_COLORS = ['bg-primary', 'bg-secondary', 'bg-accent-coral', 'bg-accent-teal', 'bg-accent-amber'];
```

Using `-foreground` variants gives saturated solid bars (the badge backgrounds are too pale for thin segments). Fallbacks now reuse the brand palette so unknown statuses pick up the active theme.

## Step 6 — Refactor remaining components

**`CommandSnippet.tsx` line 13** — change `bg-slate-950 text-slate-100` → `bg-code text-code-foreground`.

**`AppShell.tsx` line 99** — change `bg-slate-950/40` → `bg-overlay/40`.

**`ColorPicker.tsx` lines 11, 20** — `#64748b` is a fallback default for an empty hex input. Either:
- Leave as-is (it's a hex placeholder for a hex input, not a UI color), or
- Replace with a neutral default like `#888888` if the slate connotation feels off.
Recommend leaving as-is — this is a literal default value the user sees in a hex picker, not a styling concern.

**`SettingsPage.tsx`** — replace inline emerald/rose banner classes:
- success banner: `border-success/40 bg-success/20 text-success-foreground`
- error banner: `border-error/40 bg-error/20 text-error-foreground`

**`ProjectDetail.tsx`** — the one `border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300` instance becomes `border-warning text-warning-foreground`.

Sweep `dashboard/src/pages/*.tsx` once more with `rg "bg-(slate|emerald|rose|amber|violet|red|teal|zinc)-"` to catch any stragglers.

## Reusing existing utilities

- `cn()` from `dashboard/src/lib/utils.ts` — already used everywhere; keep using it for class composition.
- `useStatusConfig()` — `ProgressBar` already calls this for ordering; keep that intact.
- `applyPreset()` / `applyScheme()` in `dashboard/src/theme.tsx` — no change needed; the `data-theme` attribute is already wired.

## Verification

1. `cd /Users/brennen/syntaur/dashboard && npm run typecheck` (or `tsc --noEmit`) — must pass.
2. `npm run build` — Tailwind has to JIT-compile the new `bg-status-*`, `border-status-*`, `bg-code`, `bg-overlay`, `bg-success`, etc. classes. If any token is misnamed in `tailwind.config.ts` it will silently miss; spot-check the built CSS for `.bg-status-pending` rules.
3. Run the dashboard (`npm run dev` or however the project starts it) and:
   - Open `/settings` and cycle through presets (default → ocean → forest → sunset). Confirm: backgrounds, sidebar, cards, borders all visibly shift hue between presets — not just buttons. The dot-grid background pattern should also shift.
   - Toggle dark/light mode within each preset.
   - Visit a project page with assignments to verify `StatusBadge` colors look right in every status state, in both schemes, in every preset.
   - Trigger a `ProgressBar` with mixed statuses; verify segment colors are visible and theme-coherent.
   - Open an assignment that renders markdown with code (`prose-syntaur`); verify `pre` blocks use the new `--code` background and that inline code uses muted bg.
   - Resize to mobile and open the nav drawer to confirm the overlay still dims correctly.
   - Trigger a success banner (save settings) and an error banner (intentionally invalid input) on `SettingsPage`.
4. No tests appear to cover the dashboard styles; visual verification is the contract here.

## Out of scope

- Adding a custom-theme builder UI (user picks their own colors). Possible follow-up; not needed for "true theme."
- Per-preset status color shifts (e.g., ocean's "completed" leaning teal). Status tokens stay universal in this pass.
- Any backend/server changes — `src/dashboard/server.ts` and `src/utils/config.ts` already persist preset choice correctly.
