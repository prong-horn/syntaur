# Plan: `syntaur browse` — Interactive TUI Mission Browser

## Context

Currently, browsing missions and assignments requires either the web dashboard or manually running CLI commands with known slugs. There's no interactive way to discover and select assignments from the terminal. This TUI tool provides a keyboard-navigable tree browser with fuzzy search that lets users explore missions, pick an assignment, and launch Claude Code with the active context set — all without leaving the terminal.

## New Dependencies

- `ink` v5 — React-based terminal UI framework
- `react` v18 — peer dependency for Ink
- `ink-text-input` — text input component for search bar
- `fuse.js` — lightweight fuzzy search library

## File Structure

```
src/tui/
  App.tsx                    — Root component, layout orchestration
  types.ts                   — TreeNode type
  colors.ts                  — Status/priority color mapping
  launch.ts                  — Write context.json + spawn claude
  hooks/
    useMissions.ts           — Load data via existing API functions
    useTreeState.ts          — Cursor, expand/collapse, scroll state
    useSearch.ts             — Fuse.js integration
  components/
    TreeView.tsx             — Renders visible slice of flat node list
    TreeItem.tsx             — Single row: chevron, title, badge, priority, assignee
    SearchBar.tsx            — Text input with /prefix, escape to clear
    StatusBar.tsx            — Bottom bar with keybinding hints
    StatusBadge.tsx          — Colored status text
src/commands/browse.ts       — Commander action, dynamic-imports Ink app
```

## Build Changes

**`tsconfig.json`** — Add `"jsx": "react-jsx"` to compilerOptions

**`tsup.config.ts`** — Add esbuild JSX config:
```ts
esbuildOptions(options) {
  options.jsx = 'automatic';
}
```

No new entry points needed — `browse.ts` dynamically imports the TSX app.

## Component Design

### Tree Data Model (`src/tui/types.ts`)
```ts
interface TreeNode {
  id: string;                  // "m:<slug>" or "a:<mslug>:<aslug>"
  kind: 'mission' | 'assignment';
  label: string;
  slug: string;
  missionSlug: string;
  status: string;
  priority?: string;
  assignee?: string | null;
  workspace?: WorkspaceInfo;
  children?: TreeNode[];       // assignments (mission nodes only)
}
```

### App Layout (top → bottom)
1. **Header** — "Syntaur" + mission count
2. **SearchBar** — `/` activates, Esc clears
3. **TreeView** — scrollable viewport (terminal height minus chrome)
4. **StatusBar** — keybinding hints, selected item info

### Keyboard Controls
| Key | Action |
|-----|--------|
| `↑`/`k` | Move cursor up |
| `↓`/`j` | Move cursor down |
| `→`/`Enter` on mission | Expand |
| `←` on mission | Collapse |
| `←` on assignment | Jump to parent mission |
| `Enter` on assignment | Launch Claude Code |
| `/` | Activate search |
| `Esc` | Clear search / exit search mode |
| `q` | Quit |

### TreeItem Rendering
```
 ▸ Build Auth System              active   3/7 done
   ▪ Implement OAuth flow         in_progress  high  @claude
   ▪ Design auth schema           completed
   ▪ Write auth tests             pending
```
- Mission rows: chevron (▸/▾), title, computed status, progress fraction
- Assignment rows: indented, bullet, title, colored status badge, priority (!! or !), assignee
- Cursor row gets inverse/highlight styling

### Fuzzy Search
- Fuse.js indexes all nodes by: label, slug, status, assignee, priority
- On match, auto-expand missions containing matching assignments
- Matching nodes highlighted; non-matching hidden
- Esc clears filter and restores previous expansion state

### Viewport Scrolling
- `scrollOffset` tracks the top of the visible window
- Viewport height = `process.stdout.rows - 6` (header + search + status + padding)
- Cursor movement auto-scrolls when it exits the viewport

## Launcher (`src/tui/launch.ts`)

When an assignment is selected:

1. Determine workspace dir: `workspace.worktreePath` > `workspace.repository` (if local) > `process.cwd()`
2. Write `.syntaur/context.json` in the workspace dir (same format as grab-assignment skill):
   ```json
   {
     "missionSlug": "...",
     "assignmentSlug": "...",
     "missionDir": "~/.syntaur/missions/<mission>",
     "assignmentDir": "~/.syntaur/missions/<mission>/assignments/<assignment>",
     "workspaceRoot": "<resolved-path>",
     "title": "...",
     "branch": "...",
     "grabbedAt": "<ISO 8601>"
   }
   ```
3. Unmount Ink app (release terminal)
4. `spawn('claude', [], { cwd: workspaceDir, stdio: 'inherit' })` — hand full terminal control to Claude Code
5. Forward exit code

## Command Registration

**`src/commands/browse.ts`** — Dynamic imports to keep main CLI fast:
```ts
export async function browseCommand(): Promise<void> {
  const { render } = await import('ink');
  const React = await import('react');
  const { App } = await import('../tui/App.js');
  const config = await readConfig();
  const { waitUntilExit } = render(React.createElement(App, { missionsDir: config.defaultMissionDir }));
  await waitUntilExit();
}
```

**`src/index.ts`** — Register:
```ts
program.command('browse').description('Interactive mission & assignment browser').action(browseCommand);
```

## Data Reuse

- `listMissions()` from `src/dashboard/api.ts` — gets all mission summaries with progress counts
- `getMissionDetail()` from `src/dashboard/api.ts` — gets assignments for a mission
- `MissionSummary`, `AssignmentSummary`, `WorkspaceInfo` from `src/dashboard/types.ts`
- `readConfig()` from `src/utils/config.ts` — resolves missions directory

## Implementation Order

1. Install deps: `npm install ink react fuse.js ink-text-input` + `npm install -D @types/react`
2. Update `tsconfig.json` (add jsx) and `tsup.config.ts` (add esbuild jsx option)
3. Create `src/tui/types.ts` and `src/tui/colors.ts`
4. Create `src/tui/hooks/useMissions.ts`
5. Create `src/tui/hooks/useTreeState.ts`
6. Create `src/tui/hooks/useSearch.ts`
7. Create components: StatusBadge → TreeItem → TreeView → SearchBar → StatusBar
8. Create `src/tui/App.tsx`
9. Create `src/tui/launch.ts`
10. Create `src/commands/browse.ts`
11. Register in `src/index.ts`

## Verification

1. `npm run build` — confirm TSX compilation succeeds
2. `syntaur browse` with sample missions in `~/.syntaur/missions/`
3. Test keyboard navigation: up/down, expand/collapse, scroll with many items
4. Test fuzzy search: type partial name, verify filtering and auto-expand
5. Test assignment selection: verify context.json written, Claude Code launches in correct directory
6. Test edge cases: no missions, empty mission (no assignments), assignment with no workspace configured
