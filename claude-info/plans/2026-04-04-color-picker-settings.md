# Color Picker for Settings Page

## Context

The Settings page (`dashboard/src/pages/SettingsPage.tsx`) has a "Color" column in the Status Definitions table that is currently a plain text input where users type color names like "slate", "amber", etc. This is error-prone and gives no visual feedback. The user wants a visual color picker dropdown (as shown in the screenshot) that displays available Tailwind color families as labeled swatches.

## Plan

### 1. Create a `ColorPicker` component

**File**: `dashboard/src/components/ColorPicker.tsx`

A dropdown selector that:
- Shows the currently selected color as a swatch + label in a compact trigger button (fits in the table cell, roughly the same footprint as the current `w-24` text input)
- On click, opens a popover/dropdown listing all available Tailwind color families as rows with a color swatch dot and the color name
- Available colors: `slate`, `gray`, `zinc`, `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`, `fuchsia`, `pink`, `rose`
- Each option shows a small filled circle using the 500-weight of that color (e.g., `bg-slate-500`) plus the name
- Selecting a color calls `onChange(colorName)`
- Uses Radix UI Popover (already a project dependency via shadcn pattern) for the dropdown

### 2. Wire it into SettingsPage

**File**: `dashboard/src/pages/SettingsPage.tsx`

Replace the color text `<input>` (lines 268-274) with the new `<ColorPicker>` component:

```tsx
<ColorPicker
  value={s.color}
  onChange={(color) => updateStatus(i, 'color', color)}
/>
```

### 3. Color swatch mapping

Define a `TAILWIND_COLORS` array in `ColorPicker.tsx` mapping color names to their 500-weight hex values for the preview dots. This avoids needing to safelist dozens of Tailwind classes — we use inline `style={{ backgroundColor }}` for the dots instead.

```ts
const TAILWIND_COLORS = [
  { name: 'slate', hex: '#64748b' },
  { name: 'gray', hex: '#6b7280' },
  { name: 'zinc', hex: '#71717a' },
  { name: 'red', hex: '#ef4444' },
  { name: 'orange', hex: '#f97316' },
  { name: 'amber', hex: '#f59e0b' },
  { name: 'yellow', hex: '#eab308' },
  { name: 'lime', hex: '#84cc16' },
  { name: 'green', hex: '#22c55e' },
  { name: 'emerald', hex: '#10b981' },
  { name: 'teal', hex: '#14b8a6' },
  { name: 'cyan', hex: '#06b6d4' },
  { name: 'sky', hex: '#0ea5e9' },
  { name: 'blue', hex: '#3b82f6' },
  { name: 'indigo', hex: '#6366f1' },
  { name: 'violet', hex: '#8b5cf6' },
  { name: 'purple', hex: '#a855f7' },
  { name: 'fuchsia', hex: '#d946ef' },
  { name: 'pink', hex: '#ec4899' },
  { name: 'rose', hex: '#f43f5e' },
] as const;
```

## Files to modify
- **Create**: `dashboard/src/components/ColorPicker.tsx`
- **Edit**: `dashboard/src/pages/SettingsPage.tsx` (swap text input for ColorPicker)

## Verification
1. `cd dashboard && npm run build` — no type/build errors
2. Open Settings page in browser, verify the color column shows swatches instead of text inputs
3. Click a color cell — dropdown opens with all color options
4. Select a color — dropdown closes, swatch updates, dirty state triggers
5. Save — color persists on reload
