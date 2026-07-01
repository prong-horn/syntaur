# Syntaur Agent Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a resident, fullscreen, mouse-driven Ink TUI (`syntaur tui`) that browses projects/assignments, launches agents (into tmux), and monitors/attaches to live agent sessions.

**Architecture:** Grow the existing Ink/React TUI (`src/tui/`). Add three owned subsystems — a mouse input layer (buffered SGR 1006 parser + hit-test registry fed by **layout-computed** rects), a session feed (reusing `listAllSessions`/`enrichSessions`), and a tmux launch/attach layer — then compose them into a fullscreen alternate-screen cockpit shell. Everything degrades gracefully without tmux.

**Tech Stack:** TypeScript (ESM), Node ≥20, Ink 7 + React 19, `commander`, `better-sqlite3`, `chokidar`, `vitest` + `ink-testing-library`, `tsup` build.

**Design spec:** `claude-info/plans/2026-07-01-syntaur-tui-cockpit-design.md`

> **Revision note (2026-07-01):** This plan incorporates the Codex plan-review. Corrections baked in: real Ink 7 API names (`alternateScreen`, `useWindowSize→{columns,rows}`, `measureElement→{width,height}` only, `useApp().suspendTerminal`); **layout-driven hit-testing** (dropped per-element `measureElement`, which returns no position); a **stateful, buffered** SGR parser with corrected wheel/button classification; raw-mode teardown via cleanup; `useInput`/mouse coexistence guard; correct source symbols (`statusColors`, `getAssignmentDetail`/`getAssignmentDetailById`, `.action(runCommand(...))`, `BuiltArgv`); tmux target *derived* from session `projectSlug`/`assignmentSlug`; `ink-testing-library` added as a dep.

## Global Constraints

- **Runtime:** Node `>=20`, ES modules only (`.js` import specifiers in TS source).
- **Ink version:** upgrade to `ink@^7`. Verified Ink 7 APIs used here:
  - `render(<App/>, { alternateScreen: true })` — alternate-screen buffer, restored on exit.
  - `useWindowSize()` returns **`{ columns, rows }`** (NOT width/height).
  - `useApp()` exposes **`suspendTerminal(callback?)`** — hands the terminal to a child process, then restores; used for attach and hand-off launch.
  - `measureElement(ref)` returns **`{ width, height }` only** (no position) → do NOT use it for hit-testing.
  - `useStdin()` → `{ stdin, setRawMode, isRawModeSupported }`; `useStdout()` → `{ stdout, write }`.
  - No native mouse — the mouse layer is hand-written.
- **Hit-testing is layout-driven.** The cockpit computes region rectangles from `{columns, rows}` + rail width and feeds them to the registry; row-level targets are resolved arithmetically (`rowIndex = mouseY - listTop`). No dependency on per-element measured positions.
- **No `ink-mouse`** (archived). Add `ink-testing-library` as a devDependency for component tests.
- **No regression to `browse`.** The existing `syntaur browse` command and `src/tui/` components must keep working after the Ink 7 bump.
- **Keyboard parity.** Every mouse action has a keyboard equivalent.
- **tmux is optional.** Browse + monitor work with no tmux; launch falls back to the existing hand-off spawn; attach is disabled. Reuse `checkTmuxAvailable` (in `src/dashboard/scanner.ts`).
- **Session feed is read-only.** It does NOT call `reconcileActiveSessions` (that mutates rows and races the dashboard writer); liveness comes from `enrichSessions`.
- **Testing:** `vitest`, pure functions with injectable seams (mirror `LivenessDeps` and `launch.ts` `spawnFn`). Component tests use `ink-testing-library`.
- **Test-file typecheck blindspot:** `tsconfig` excludes test dirs — after any signature change, run a type-aware `tsc` probe over touched test files.
- **Fresh worktree setup:** root `npm install` + root `npm run build` + `npm install --prefix dashboard` before `npm test`.
- **Commit style:** conventional commits; commit at the end of each task.

---

### Task 1: Upgrade Ink 6.8 → 7, add test lib, verify browse

**Files:**
- Modify: `package.json` (`ink` dependency; add `ink-testing-library` devDependency)
- Modify: `vitest.config.ts` (broaden `include` to colocated tests)
- Modify: `tsconfig.json` (exclude colocated test files from the build)
- Verify (read-only): `node_modules/ink/build/index.d.ts`
- Smoke: `src/commands/browse.ts` (run only)

**Interfaces:**
- Produces: Ink 7 installed; the verified names in Global Constraints are now real imports available to later tasks; `ink-testing-library` available to component tests; test runner + typechecker configured for colocated `**/__tests__/*.test.{ts,tsx}`.

- [ ] **Step 1: Bump deps**

Edit `package.json`: set `"ink": "^7.0.0"`; add `"ink-testing-library": "^4.0.0"` under `devDependencies`. Then:

```bash
cd /Users/brennen/syntaur/.worktrees/tui-agent-cockpit && npm install
```
Expected: ink 7.x + ink-testing-library install cleanly against `react@19`.

- [ ] **Step 1b: Wire up colocated tests (CRITICAL — else new tests silently never run and get built into dist)**

The repo currently runs only `src/__tests__/**/*.test.ts` (`vitest.config.ts:18`) and excludes only `src/__tests__` from the build (`tsconfig.json:20`). This plan colocates tests in `src/**/__tests__/*.test.{ts,tsx}`. Update BOTH configs deliberately:

In `vitest.config.ts`, broaden `include`:
```ts
    include: ['src/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
```
In `tsconfig.json`, extend `exclude` so colocated tests aren't compiled into `dist`:
```json
  "exclude": ["node_modules", "dist", "src/__tests__", "src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.test.tsx"]
```
Verify the existing suite still collects and JSX tests are supported (the project already compiles `src/tui/*.tsx`, so `jsx` is configured):
```bash
npx vitest run src/__tests__ >/dev/null && echo "existing suite still discovered"
```
Expected: existing tests still run; the new globs additionally cover colocated `__tests__` dirs.

- [ ] **Step 2: Confirm the API surface actually matches (anti-regression gate)**

```bash
grep -nE "alternateScreen|useWindowSize|suspendTerminal|useBoxMetrics|measureElement|useStdin|useStdout" node_modules/ink/build/index.d.ts
```
Expected: `alternateScreen` render option; `useWindowSize(): {columns, rows}`; `suspendTerminal` on the app context; `measureElement(): {width, height}`. **If any differ from the Global Constraints, STOP and reconcile the plan before continuing** — these names are load-bearing.

- [ ] **Step 3: Build + smoke browse**

```bash
npm run build && node bin/syntaur.js browse
```
Expected: existing tree TUI renders and responds to `↑/↓/j/k`, `/`, `q`, unchanged. Fix any Ink-7-removed prop usage in `src/tui/` minimally to restore parity.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck && npm run build --prefix dashboard
git add package.json package-lock.json src/tui
git commit -m "chore(tui): upgrade ink 6.8 -> 7, add ink-testing-library"
```

---

### Task 2: Buffered SGR 1006 mouse parser (pure, stateful)

**Files:**
- Create: `src/tui/mouse/parse.ts`
- Test: `src/tui/mouse/__tests__/parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MouseButton = 'left' | 'middle' | 'right' | 'none';
  export type MouseAction = 'down' | 'up' | 'move' | 'scroll-up' | 'scroll-down';
  export interface MouseEvent { x: number; y: number; button: MouseButton; action: MouseAction; }
  export class MouseParser { push(chunk: string): MouseEvent[]; } // buffers a trailing partial sequence
  export function isMouseSequence(input: string): boolean; // guards Ink useInput
  ```
  `x`/`y` are 0-indexed.

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/mouse/__tests__/parse.test.ts
import { describe, it, expect } from 'vitest';
import { MouseParser, isMouseSequence } from '../parse.js';

describe('MouseParser (SGR 1006)', () => {
  it('parses a left press and release (M/m), 0-indexing coords', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[<0;12;5M')).toEqual([{ x: 11, y: 4, button: 'left', action: 'down' }]);
    expect(p.push('\x1b[<0;12;5m')).toEqual([{ x: 11, y: 4, button: 'left', action: 'up' }]);
  });
  it('classifies wheel events by bit 6, direction by bit 0', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[<64;3;3M')[0].action).toBe('scroll-up');
    expect(p.push('\x1b[<65;3;3M')[0].action).toBe('scroll-down');
  });
  it('does NOT misclassify middle-click (cb=1) as scroll', () => {
    const p = new MouseParser();
    const e = p.push('\x1b[<1;1;1M')[0];
    expect(e.action).toBe('down');
    expect(e.button).toBe('middle');
  });
  it('parses right button (cb=2) and motion (drag bit 32) as move', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[<2;1;1M')[0].button).toBe('right');
    expect(p.push('\x1b[<35;9;9M')[0].action).toBe('move');
  });
  it('buffers a sequence split across two chunks', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[<0;1;1')).toEqual([]); // incomplete, held
    expect(p.push('M')).toEqual([{ x: 0, y: 0, button: 'left', action: 'down' }]);
  });
  it('buffers splits INSIDE the prefix (after ESC and after ESC[)', () => {
    const a = new MouseParser();
    expect(a.push('\x1b')).toEqual([]);
    expect(a.push('[<0;1;1M')).toEqual([{ x: 0, y: 0, button: 'left', action: 'down' }]);
    const b = new MouseParser();
    expect(b.push('\x1b[')).toEqual([]);
    expect(b.push('<0;1;1M')).toEqual([{ x: 0, y: 0, button: 'left', action: 'down' }]);
  });
  it('does NOT swallow a completed non-mouse escape (arrow key ESC[A)', () => {
    const p = new MouseParser();
    expect(p.push('\x1b[A')).toEqual([]);        // no mouse event
    // carry must be empty: the next real mouse chunk parses cleanly on its own
    expect(p.push('\x1b[<0;1;1M')).toEqual([{ x: 0, y: 0, button: 'left', action: 'down' }]);
  });
  it('ignores non-mouse bytes and parses multiple events in one chunk', () => {
    const p = new MouseParser();
    const evts = p.push('x\x1b[<0;1;1M\x1b[<0;1;1my');
    expect(evts.map((e) => e.action)).toEqual(['down', 'up']);
  });
  it('isMouseSequence detects an SGR mouse prefix', () => {
    expect(isMouseSequence('\x1b[<0;1;1M')).toBe(true);
    expect(isMouseSequence('q')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/mouse/__tests__/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/mouse/parse.ts
export type MouseButton = 'left' | 'middle' | 'right' | 'none';
export type MouseAction = 'down' | 'up' | 'move' | 'scroll-up' | 'scroll-down';
export interface MouseEvent {
  x: number;
  y: number;
  button: MouseButton;
  action: MouseAction;
}

// SGR 1006: ESC [ < Cb ; Cx ; Cy (M|m). M=press/motion, m=release. 1-indexed coords.
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const WHEEL_BIT = 64; // bit 6 -> wheel/scroll
const MOTION_BIT = 32; // bit 5 -> drag/motion
const BUTTON_MASK = 0b11;
const MOUSE_PREFIX = '\x1b[<';

export function isMouseSequence(input: string): boolean {
  return input.includes(MOUSE_PREFIX);
}

function buttonOf(cb: number): MouseButton {
  switch (cb & BUTTON_MASK) {
    case 0: return 'left';
    case 1: return 'middle';
    case 2: return 'right';
    default: return 'none';
  }
}

function toEvent(cb: number, x1: number, y1: number, terminator: string): MouseEvent {
  const x = x1 - 1;
  const y = y1 - 1;
  if ((cb & WHEEL_BIT) !== 0) {
    return { x, y, button: 'none', action: (cb & 1) === 0 ? 'scroll-up' : 'scroll-down' };
  }
  if ((cb & MOTION_BIT) !== 0) {
    return { x, y, button: buttonOf(cb), action: 'move' };
  }
  return { x, y, button: buttonOf(cb), action: terminator === 'm' ? 'up' : 'down' };
}

export class MouseParser {
  private carry = '';

  push(chunk: string): MouseEvent[] {
    const data = this.carry + chunk;
    this.carry = '';
    const out: MouseEvent[] = [];
    SGR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let end = 0;
    while ((m = SGR_RE.exec(data)) !== null) {
      out.push(toEvent(Number(m[1]), Number(m[2]), Number(m[3]), m[4]));
      end = SGR_RE.lastIndex;
    }
    // Hold a trailing PARTIAL mouse sequence for the next chunk. Match only a
    // valid mouse-sequence prefix (ESC, ESC[, ESC[<, ESC[<Cb;Cx;Cy...) so we
    // never swallow a completed non-mouse escape like an arrow key (ESC[A).
    const tail = data.slice(end);
    const esc = tail.lastIndexOf('\x1b');
    if (esc !== -1) {
      const frag = tail.slice(esc);
      if (PARTIAL_MOUSE_RE.test(frag)) this.carry = frag;
    }
    return out;
  }
}
```

where the partial-prefix matcher sits with the other constants:

```ts
// A trailing fragment that is a prefix of a valid SGR mouse sequence (no
// terminator yet). Anchored so `\x1b[A` (arrow) and other escapes do NOT match.
const PARTIAL_MOUSE_RE = /^\x1b(\[(<\d*(;\d*(;\d*)?)?)?)?$/;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/mouse/__tests__/parse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/mouse/parse.ts src/tui/mouse/__tests__/parse.test.ts
git commit -m "feat(tui): buffered SGR 1006 mouse parser with correct wheel/button classification"
```

---

### Task 3: Mouse tracking enable/disable

**Files:**
- Create: `src/tui/mouse/tracking.ts`
- Test: `src/tui/mouse/__tests__/tracking.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function enableMouseTracking(write: (s: string) => void): void;
  export function disableMouseTracking(write: (s: string) => void): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/mouse/__tests__/tracking.test.ts
import { describe, it, expect } from 'vitest';
import { enableMouseTracking, disableMouseTracking } from '../tracking.js';

describe('mouse tracking mode', () => {
  it('enable writes 1000 + 1002 + 1006 set sequences', () => {
    let buf = '';
    enableMouseTracking((s) => (buf += s));
    expect(buf).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  });
  it('disable writes the resets in reverse', () => {
    let buf = '';
    disableMouseTracking((s) => (buf += s));
    expect(buf).toBe('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/mouse/__tests__/tracking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/mouse/tracking.ts
// 1000 = button tracking, 1002 = drag tracking, 1006 = SGR extended coords.
const SEQUENCES = ['\x1b[?1000', '\x1b[?1002', '\x1b[?1006'];
export function enableMouseTracking(write: (s: string) => void): void {
  for (const s of SEQUENCES) write(`${s}h`);
}
export function disableMouseTracking(write: (s: string) => void): void {
  for (const s of [...SEQUENCES].reverse()) write(`${s}l`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/mouse/__tests__/tracking.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/mouse/tracking.ts src/tui/mouse/__tests__/tracking.test.ts
git commit -m "feat(tui): enable/disable SGR mouse tracking"
```

---

### Task 4: Hit-test registry (pure, fed layout rects)

**Files:**
- Create: `src/tui/mouse/registry.ts`
- Test: `src/tui/mouse/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `MouseEvent` from `./parse.js`.
- Produces:
  ```ts
  export interface Rect { x: number; y: number; width: number; height: number; }
  export interface Region { id: string; rect: Rect; onClick?: (e: MouseEvent) => void; onScroll?: (e: MouseEvent) => void; z?: number; }
  export function rectContains(rect: Rect, x: number, y: number): boolean;
  export class HitRegistry { set(r: Region): void; remove(id: string): void; clear(): void; dispatch(e: MouseEvent): boolean; }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/mouse/__tests__/registry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HitRegistry } from '../registry.js';
import type { MouseEvent } from '../parse.js';

const at = (x: number, y: number, action: MouseEvent['action'] = 'down'): MouseEvent => ({
  x, y, button: action.startsWith('scroll') ? 'none' : 'left', action,
});

describe('HitRegistry', () => {
  it('fires onClick for a down inside a region', () => {
    const r = new HitRegistry(); const spy = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 10, height: 2 }, onClick: spy });
    expect(r.dispatch(at(3, 1))).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });
  it('does nothing outside every region', () => {
    const r = new HitRegistry(); const spy = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 2, height: 2 }, onClick: spy });
    expect(r.dispatch(at(9, 9))).toBe(false);
  });
  it('routes scroll to onScroll not onClick', () => {
    const r = new HitRegistry(); const click = vi.fn(); const scroll = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: click, onScroll: scroll });
    r.dispatch(at(1, 1, 'scroll-down'));
    expect(scroll).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });
  it('higher z wins on overlap', () => {
    const r = new HitRegistry(); const lo = vi.fn(); const hi = vi.fn();
    r.set({ id: 'lo', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: lo, z: 0 });
    r.set({ id: 'hi', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: hi, z: 5 });
    r.dispatch(at(2, 2));
    expect(hi).toHaveBeenCalledOnce();
    expect(lo).not.toHaveBeenCalled();
  });
  it('remove unregisters', () => {
    const r = new HitRegistry(); const spy = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: spy });
    r.remove('a');
    expect(r.dispatch(at(1, 1))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/mouse/__tests__/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/mouse/registry.ts
import type { MouseEvent } from './parse.js';

export interface Rect { x: number; y: number; width: number; height: number; }
export interface Region {
  id: string;
  rect: Rect;
  onClick?: (e: MouseEvent) => void;
  onScroll?: (e: MouseEvent) => void;
  z?: number;
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export class HitRegistry {
  private regions = new Map<string, Region>();
  set(region: Region): void { this.regions.set(region.id, region); }
  remove(id: string): void { this.regions.delete(id); }
  clear(): void { this.regions.clear(); }
  dispatch(e: MouseEvent): boolean {
    const target = [...this.regions.values()]
      .filter((r) => rectContains(r.rect, e.x, e.y))
      .sort((a, b) => (b.z ?? 0) - (a.z ?? 0))[0];
    if (!target) return false;
    if (e.action === 'scroll-up' || e.action === 'scroll-down') {
      if (target.onScroll) { target.onScroll(e); return true; }
      return false;
    }
    if (e.action === 'down' && target.onClick) { target.onClick(e); return true; }
    return false;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/mouse/__tests__/registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/mouse/registry.ts src/tui/mouse/__tests__/registry.test.ts
git commit -m "feat(tui): hit-test registry (z-ordered, scroll routing)"
```

---

### Task 5: Mouse React layer (provider + region hook + input guard)

**Files:**
- Create: `src/tui/mouse/MouseContext.tsx`
- Create: `src/tui/mouse/hooks.ts`
- Test: `src/tui/mouse/__tests__/MouseContext.test.tsx`

**Interfaces:**
- Consumes: `MouseParser` (Task 2), `enable/disableMouseTracking` (Task 3), `HitRegistry`/`Region` (Task 4); Ink `useStdin`, `useStdout`.
- Produces:
  ```ts
  export const MouseProvider: React.FC<{ children: React.ReactNode }>;
  export function useHitRegistry(): HitRegistry;
  export function useMouseRegions(regions: Region[]): void; // upsert on mount, remove on unmount
  ```
  `MouseProvider` enables raw mode + mouse tracking, feeds a single `MouseParser` from `stdin`, dispatches to one `HitRegistry`, and **restores raw mode + tracking on cleanup**. Views register layout-computed rects via `useMouseRegions`. Ink `useInput` handlers early-return on `isMouseSequence(input)` (enforced in Tasks 10/11/13).

- [ ] **Step 1: Write the failing test**

```tsx
// src/tui/mouse/__tests__/MouseContext.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { MouseProvider, useHitRegistry } from '../MouseContext.js';
import { useMouseRegions } from '../hooks.js';

function Probe({ onHit }: { onHit: () => void }) {
  const registry = useHitRegistry();
  useMouseRegions([{ id: 'p', rect: { x: 0, y: 0, width: 5, height: 1 }, onClick: onHit }]);
  React.useEffect(() => { registry.dispatch({ x: 2, y: 0, button: 'left', action: 'down' }); });
  return <Text>probe</Text>;
}

describe('MouseProvider + useMouseRegions', () => {
  it('registers a region reachable by the shared registry', () => {
    const onHit = vi.fn();
    render(<MouseProvider><Probe onHit={onHit} /></MouseProvider>);
    expect(onHit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/mouse/__tests__/MouseContext.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

```tsx
// src/tui/mouse/MouseContext.tsx
import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useStdin, useStdout } from 'ink';
import { HitRegistry } from './registry.js';
import { MouseParser } from './parse.js';
import { enableMouseTracking, disableMouseTracking } from './tracking.js';

const MouseCtx = createContext<HitRegistry | null>(null);

export function useHitRegistry(): HitRegistry {
  const r = useContext(MouseCtx);
  if (!r) throw new Error('useHitRegistry must be used inside <MouseProvider>');
  return r;
}

export const MouseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const registry = useMemo(() => new HitRegistry(), []);
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { write } = useStdout();

  useEffect(() => {
    if (!isRawModeSupported || !stdin) return; // no TTY -> keyboard-only
    setRawMode(true);
    enableMouseTracking(write);
    const parser = new MouseParser();
    const onData = (data: Buffer | string) => {
      const chunk = typeof data === 'string' ? data : data.toString('utf8');
      for (const evt of parser.push(chunk)) registry.dispatch(evt);
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      disableMouseTracking(write);
      setRawMode(false);
    };
  }, [stdin, setRawMode, isRawModeSupported, write, registry]);

  return <MouseCtx.Provider value={registry}>{children}</MouseCtx.Provider>;
};
```

- [ ] **Step 4: Implement the region hook**

```ts
// src/tui/mouse/hooks.ts
import { useEffect } from 'react';
import type { Region } from './registry.js';
import { useHitRegistry } from './MouseContext.js';

export function useMouseRegions(regions: Region[]): void {
  const registry = useHitRegistry();
  useEffect(() => {
    for (const r of regions) registry.set(r);
    return () => { for (const r of regions) registry.remove(r.id); };
  }, [registry, regions]);
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run src/tui/mouse/__tests__/MouseContext.test.tsx`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/mouse/MouseContext.tsx src/tui/mouse/hooks.ts src/tui/mouse/__tests__/MouseContext.test.tsx
git commit -m "feat(tui): mouse provider (raw-mode teardown) + useMouseRegions"
```

---

### Task 6: Live session feed (read-only)

**Files:**
- Create: `src/tui/sessions/feed.ts`
- Test: `src/tui/sessions/__tests__/feed.test.ts`

**Interfaces:**
- Consumes: `listAllSessions` (`src/dashboard/agent-sessions.js`), `enrichSessions` + `LivenessDeps` (`src/dashboard/session-liveness.js`), `AgentConfig` (`src/utils/config.js`), `AgentSessionWithLiveness` (`src/dashboard/types.js`).
- Produces:
  ```ts
  export interface LoadSessionsOptions { projectsDir: string; agents: AgentConfig[]; livenessDeps?: LivenessDeps; }
  export async function loadSessions(opts: LoadSessionsOptions): Promise<AgentSessionWithLiveness[]>;
  export function liveOnly(sessions: AgentSessionWithLiveness[]): AgentSessionWithLiveness[];
  ```
  Read-only: NO `reconcileActiveSessions` (avoids mutate-and-race with the dashboard writer).

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/sessions/__tests__/feed.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { initSessionDb, getSessionDb, resetSessionDb, closeSessionDb } from '../../../dashboard/session-db.js';
import { loadSessions, liveOnly } from '../feed.js';
import type { AgentConfig } from '../../../utils/config.js';

let dir: string;
const agents: AgentConfig[] = [{ id: 'claude', label: 'Claude', command: 'claude' } as AgentConfig];

beforeEach(() => {
  resetSessionDb();
  dir = mkdtempSync(resolve(tmpdir(), 'syntaur-feed-'));
  initSessionDb(resolve(dir, 'syntaur.db'));
});
afterEach(() => { closeSessionDb(); rmSync(dir, { recursive: true, force: true }); });

function insert(id: string, status: string, pid: number | null) {
  getSessionDb().prepare(
    "INSERT INTO sessions (session_id, agent, started, status, pid) VALUES (?, 'claude', datetime('now'), ?, ?)",
  ).run(id, status, pid);
}

describe('session feed', () => {
  it('loads sessions enriched with liveness', async () => {
    insert('s1', 'active', 4242);
    const s = await loadSessions({ projectsDir: dir, agents, livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null } });
    expect(s).toHaveLength(1);
    expect(s[0].isLive).toBe(true);
  });
  it('liveOnly drops dead/terminal sessions', async () => {
    insert('dead', 'active', 9999);
    insert('done', 'completed', null);
    const s = await loadSessions({ projectsDir: dir, agents, livenessDeps: { isPidAlive: () => false } });
    expect(liveOnly(s)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/sessions/__tests__/feed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/sessions/feed.ts
import { listAllSessions } from '../../dashboard/agent-sessions.js';
import { enrichSessions, type LivenessDeps } from '../../dashboard/session-liveness.js';
import type { AgentConfig } from '../../utils/config.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';

export interface LoadSessionsOptions {
  projectsDir: string;
  agents: AgentConfig[];
  livenessDeps?: LivenessDeps;
}

export async function loadSessions(opts: LoadSessionsOptions): Promise<AgentSessionWithLiveness[]> {
  const sessions = await listAllSessions(opts.projectsDir);
  return enrichSessions(sessions, opts.agents, opts.livenessDeps);
}

export function liveOnly(sessions: AgentSessionWithLiveness[]): AgentSessionWithLiveness[] {
  return sessions.filter((s) => s.isLive);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/sessions/__tests__/feed.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/sessions/feed.ts src/tui/sessions/__tests__/feed.test.ts
git commit -m "feat(tui): read-only live session feed via listAllSessions + enrichSessions"
```

---

### Task 7: Transcript tail

**Files:**
- Create: `src/tui/sessions/transcript.ts`
- Test: `src/tui/sessions/__tests__/transcript.test.ts`

**Interfaces:**
- Consumes: `chokidar`, `node:fs`.
- Produces:
  ```ts
  export interface TailHandle { stop(): void; }
  export interface TailOptions { path: string; maxInitialLines?: number; onLines: (lines: string[]) => void; onError?: (err: Error) => void; }
  export function tailFile(opts: TailOptions): TailHandle;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/sessions/__tests__/transcript.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tailFile } from '../transcript.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'syntaur-tail-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const waitFor = (pred: () => boolean, ms = 2000) =>
  new Promise<void>((res, rej) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - start > ms) { clearInterval(iv); rej(new Error('timeout')); }
    }, 20);
  });

describe('tailFile', () => {
  it('emits existing lines then appended lines', async () => {
    const p = resolve(dir, 't.jsonl');
    writeFileSync(p, 'line1\nline2\n');
    const seen: string[] = [];
    const h = tailFile({ path: p, onLines: (ls) => seen.push(...ls) });
    await waitFor(() => seen.includes('line2'));
    appendFileSync(p, 'line3\n');
    await waitFor(() => seen.includes('line3'));
    h.stop();
    expect(seen).toEqual(['line1', 'line2', 'line3']);
  });
  it('reports a missing file via onError without throwing', async () => {
    let err: Error | null = null;
    const h = tailFile({ path: resolve(dir, 'nope.jsonl'), onLines: () => {}, onError: (e) => (err = e) });
    await waitFor(() => err !== null);
    h.stop();
    expect(err).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/sessions/__tests__/transcript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/sessions/transcript.ts
import chokidar, { type FSWatcher } from 'chokidar';
import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';

export interface TailHandle { stop(): void; }
export interface TailOptions {
  path: string;
  maxInitialLines?: number;
  onLines: (lines: string[]) => void;
  onError?: (err: Error) => void;
}

function readFrom(path: string, offset: number): { text: string; next: number } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { text: '', next: size };
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, size - offset, offset);
    return { text: buf.toString('utf8'), next: size };
  } finally {
    closeSync(fd);
  }
}

export function tailFile(opts: TailOptions): TailHandle {
  const maxInitial = opts.maxInitialLines ?? 200;
  let offset = 0;
  let carry = '';

  if (!existsSync(opts.path)) {
    opts.onError?.(new Error(`transcript not found: ${opts.path}`));
    return { stop() {} };
  }

  const emit = (initial: boolean) => {
    try {
      const { text, next } = readFrom(opts.path, offset);
      offset = next;
      if (!text) return;
      const parts = (carry + text).split('\n');
      carry = parts.pop() ?? '';
      let lines = parts;
      if (initial && lines.length > maxInitial) lines = lines.slice(-maxInitial);
      if (lines.length) opts.onLines(lines);
    } catch (err) {
      opts.onError?.(err as Error);
    }
  };

  emit(true);
  const watcher: FSWatcher = chokidar.watch(opts.path, { ignoreInitial: true });
  watcher.on('change', () => emit(false));
  watcher.on('error', (err) => opts.onError?.(err as Error));
  return { stop() { void watcher.close(); } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/sessions/__tests__/transcript.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/sessions/transcript.ts src/tui/sessions/__tests__/transcript.test.ts
git commit -m "feat(tui): transcript tail via chokidar with offset tracking"
```

---

### Task 8: tmux detection + launch (detached session)

**Files:**
- Create: `src/tui/tmux/launch.ts`
- Test: `src/tui/tmux/__tests__/launch.test.ts`

**Interfaces:**
- Consumes: `checkTmuxAvailable` (`src/dashboard/scanner.js` — reuse; confirm the import path used by `autodiscovery.ts`), `node:child_process`.
- Produces:
  ```ts
  export type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  export function tmuxSessionName(projectSlug: string | null, assignmentSlug: string): string; // deterministic, reused at attach
  export interface TmuxLaunchInput { sessionName: string; cwd: string; command: string; args: string[]; exec?: ExecFn; }
  export function buildTmuxLaunchArgv(input: TmuxLaunchInput): string[]; // `new-session -d ...`
  export async function launchInTmux(input: TmuxLaunchInput): Promise<void>;
  export async function tmuxSessionExists(sessionName: string, exec?: ExecFn): Promise<boolean>;
  ```

> **Reuse note:** Do NOT add a new tmux-availability probe — import the existing `checkTmuxAvailable` (`autodiscovery.ts` imports it from `src/dashboard/scanner.ts`). Only add a `spawn`/exec seam for the launch argv.

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/tmux/__tests__/launch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildTmuxLaunchArgv, tmuxSessionName, launchInTmux, tmuxSessionExists } from '../launch.js';

describe('tmux launch', () => {
  it('builds a detached new-session argv (name, cwd, agent argv)', () => {
    expect(buildTmuxLaunchArgv({
      sessionName: 'syntaur-p-a', cwd: '/repo/.worktrees/feat',
      command: 'claude', args: ['/grab-assignment p a', '--agent', 'b'],
    })).toEqual([
      'new-session', '-d', '-s', 'syntaur-p-a', '-c', '/repo/.worktrees/feat',
      'claude', '/grab-assignment p a', '--agent', 'b',
    ]);
  });
  it('tmuxSessionName is deterministic + strips . and :', () => {
    expect(tmuxSessionName('proj', 'my.assignment')).toBe('syntaur-proj-my-assignment');
    expect(tmuxSessionName(null, 'stand:alone')).toBe('syntaur-stand-alone');
  });
  it('launchInTmux runs the built argv through exec', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }));
    await launchInTmux({ sessionName: 'w', cwd: '/x', command: 'claude', args: ['hi'], exec });
    expect(exec).toHaveBeenCalledWith('tmux', ['new-session', '-d', '-s', 'w', '-c', '/x', 'claude', 'hi']);
  });
  it('tmuxSessionExists parses `has-session` exit', async () => {
    const ok = vi.fn(async () => ({ code: 0, stdout: '' }));
    expect(await tmuxSessionExists('w', ok)).toBe(true);
    const no = vi.fn(async () => { throw new Error('no session'); });
    expect(await tmuxSessionExists('w', no)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/tmux/__tests__/launch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/tmux/launch.ts
import { execFile } from 'node:child_process';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((res, rej) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => {
      if (err) rej(err);
      else res({ code: 0, stdout: stdout ?? '' });
    });
  });

export function tmuxSessionName(projectSlug: string | null, assignmentSlug: string): string {
  const raw = [projectSlug, assignmentSlug].filter(Boolean).join('-');
  return `syntaur-${raw.replace(/[.:]/g, '-').replace(/[^\w-]/g, '-')}`;
}

export interface TmuxLaunchInput {
  sessionName: string;
  cwd: string;
  command: string;
  args: string[];
  exec?: ExecFn;
}

export function buildTmuxLaunchArgv(input: TmuxLaunchInput): string[] {
  return ['new-session', '-d', '-s', input.sessionName, '-c', input.cwd, input.command, ...input.args];
}

export async function launchInTmux(input: TmuxLaunchInput): Promise<void> {
  await (input.exec ?? defaultExec)('tmux', buildTmuxLaunchArgv(input));
}

export async function tmuxSessionExists(sessionName: string, exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    const { code } = await exec('tmux', ['has-session', '-t', sessionName]);
    return code === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/tmux/__tests__/launch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/tmux/launch.ts src/tui/tmux/__tests__/launch.test.ts
git commit -m "feat(tui): tmux detached-session launch + deterministic session name"
```

---

### Task 9: tmux attach argv + runner (suspend handled by cockpit)

**Files:**
- Create: `src/tui/tmux/attach.ts`
- Test: `src/tui/tmux/__tests__/attach.test.ts`

**Interfaces:**
- Consumes: `node:child_process` `spawn`.
- Produces:
  ```ts
  export function buildTmuxAttachArgv(sessionName: string): string[];
  type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => { on(evt: string, cb: (arg?: unknown) => void): void };
  export function runTmuxAttach(sessionName: string, spawnFn?: SpawnLike): Promise<void>;
  ```
  The cockpit wraps `runTmuxAttach` inside Ink's `useApp().suspendTerminal(async () => runTmuxAttach(name))` (Task 15); Ink handles leaving/restoring the alt-screen.

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/tmux/__tests__/attach.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildTmuxAttachArgv, runTmuxAttach } from '../attach.js';

function fakeChild(exitCode = 0) {
  const h: Record<string, (a?: unknown) => void> = {};
  queueMicrotask(() => h['exit']?.(exitCode));
  return { on: (evt: string, cb: (a?: unknown) => void) => { h[evt] = cb; } };
}

describe('tmux attach', () => {
  it('builds attach argv', () => {
    expect(buildTmuxAttachArgv('w')).toEqual(['attach-session', '-t', 'w']);
  });
  it('runTmuxAttach spawns inherit and resolves on child exit', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    await runTmuxAttach('w', spawnFn as never);
    expect(spawnFn).toHaveBeenCalledWith('tmux', ['attach-session', '-t', 'w'], { stdio: 'inherit' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/tmux/__tests__/attach.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/tmux/attach.ts
import { spawn } from 'node:child_process';

export function buildTmuxAttachArgv(sessionName: string): string[] {
  return ['attach-session', '-t', sessionName];
}

type MinimalChild = { on(evt: string, cb: (arg?: unknown) => void): void };
type SpawnLike = (cmd: string, args: string[], opts: { stdio: 'inherit' }) => MinimalChild;

export function runTmuxAttach(sessionName: string, spawnFn?: SpawnLike): Promise<void> {
  const spawnImpl: SpawnLike = spawnFn ?? ((c, a, o) => spawn(c, a, o) as unknown as MinimalChild);
  return new Promise<void>((resolvePromise) => {
    const child = spawnImpl('tmux', buildTmuxAttachArgv(sessionName), { stdio: 'inherit' });
    const done = () => resolvePromise();
    child.on('exit', done);
    child.on('error', done);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/tmux/__tests__/attach.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/tmux/attach.ts src/tui/tmux/__tests__/attach.test.ts
git commit -m "feat(tui): tmux attach runner (suspend handled by cockpit)"
```

---

### Task 10: Layout (columns/rows + region rects) + cockpit shell

**Files:**
- Create: `src/tui/cockpit/layout.ts`
- Create: `src/tui/cockpit/Cockpit.tsx`
- Test: `src/tui/cockpit/__tests__/layout.test.ts`
- Test: `src/tui/cockpit/__tests__/Cockpit.test.tsx`

**Interfaces:**
- Consumes: `MouseProvider` (Task 5), `Rect` (Task 4); Ink `useWindowSize` (`{columns, rows}`), `useApp`, `useInput`; `isMouseSequence` (Task 2).
- Produces:
  ```ts
  export type FocusTarget = 'rail' | 'detail';
  export interface CockpitRegions { rail: Rect; detail: Rect; actionBar: Rect; }
  export interface CockpitLayout { columns: 1 | 2; railWidth: number; columnsTotal: number; rowsTotal: number; regions: CockpitRegions; }
  export function computeLayout(columns: number, rows: number): CockpitLayout;
  export const Cockpit: React.FC<{ projectsDir: string; assignmentsDir: string; tmuxAvailable: boolean }>;
  ```

- [ ] **Step 1: Write the failing layout test**

```ts
// src/tui/cockpit/__tests__/layout.test.ts
import { describe, it, expect } from 'vitest';
import { computeLayout } from '../layout.js';

describe('computeLayout', () => {
  it('two columns wide; rail 28..40; action bar on last row', () => {
    const l = computeLayout(120, 40);
    expect(l.columns).toBe(2);
    expect(l.railWidth).toBeGreaterThanOrEqual(28);
    expect(l.railWidth).toBeLessThanOrEqual(40);
    expect(l.regions.actionBar).toEqual({ x: 0, y: 39, width: 120, height: 1 });
    expect(l.regions.rail.x).toBe(0);
    expect(l.regions.detail.x).toBe(l.railWidth);
    expect(l.regions.rail.height).toBe(39);
  });
  it('single column below 80 cols', () => {
    const l = computeLayout(70, 30);
    expect(l.columns).toBe(1);
    expect(l.regions.rail.width).toBe(70);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement layout**

```ts
// src/tui/cockpit/layout.ts
import type { Rect } from '../mouse/registry.js';

export type FocusTarget = 'rail' | 'detail';
export interface CockpitRegions { rail: Rect; detail: Rect; actionBar: Rect; }
export interface CockpitLayout {
  columns: 1 | 2;
  railWidth: number;
  columnsTotal: number;
  rowsTotal: number;
  regions: CockpitRegions;
}

export function computeLayout(columns: number, rows: number): CockpitLayout {
  const bodyHeight = Math.max(1, rows - 1);
  const actionBar: Rect = { x: 0, y: rows - 1, width: columns, height: 1 };

  if (columns < 80) {
    const railHeight = Math.floor(bodyHeight / 2);
    return {
      columns: 1, railWidth: columns, columnsTotal: columns, rowsTotal: rows,
      regions: {
        rail: { x: 0, y: 0, width: columns, height: railHeight },
        detail: { x: 0, y: railHeight, width: columns, height: bodyHeight - railHeight },
        actionBar,
      },
    };
  }
  const railWidth = Math.min(40, Math.max(28, Math.floor(columns * 0.28)));
  return {
    columns: 2, railWidth, columnsTotal: columns, rowsTotal: rows,
    regions: {
      rail: { x: 0, y: 0, width: railWidth, height: bodyHeight },
      detail: { x: railWidth, y: 0, width: columns - railWidth, height: bodyHeight },
      actionBar,
    },
  };
}
```

- [ ] **Step 4: Run layout test**

Run: `npx vitest run src/tui/cockpit/__tests__/layout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement the shell**

```tsx
// src/tui/cockpit/Cockpit.tsx
import React, { useState } from 'react';
import { Box, Text, useInput, useApp, useWindowSize } from 'ink';
import { MouseProvider } from '../mouse/MouseContext.js';
import { isMouseSequence } from '../mouse/parse.js';
import { computeLayout, type FocusTarget } from './layout.js';

export const Cockpit: React.FC<{ projectsDir: string; assignmentsDir: string; tmuxAvailable: boolean }> = ({
  projectsDir,
  assignmentsDir,
  tmuxAvailable,
}) => {
  const { exit } = useApp();
  const size = useWindowSize();
  const columns = size.columns || 80;
  const rows = size.rows || 24;
  const layout = computeLayout(columns, rows);
  const [focus, setFocus] = useState<FocusTarget>('rail');

  useInput((input, key) => {
    if (isMouseSequence(input)) return; // mouse bytes also reach Ink input
    if (input === 'q' || key.escape) exit();
    if (key.tab) setFocus((f) => (f === 'rail' ? 'detail' : 'rail'));
  });

  // CRITICAL: no borders on hit-tested regions and EXPLICIT width/height from
  // `layout.regions` (never flexGrow) — so each rendered Box occupies exactly
  // its layout rect and mouse (x,y) maps 1:1. Focus is shown via header color,
  // not a border (a border insets content by 1 cell and desyncs coordinates).
  const { rail, detail, actionBar } = layout.regions;
  return (
    <MouseProvider>
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexDirection={layout.columns === 2 ? 'row' : 'column'} height={rows - actionBar.height}>
          <Box width={rail.width} height={rail.height} flexDirection="column">
            <Text bold color={focus === 'rail' ? 'cyan' : undefined}>{`Rail (projectsDir=${projectsDir})`}</Text>
          </Box>
          <Box width={detail.width} height={detail.height} flexDirection="column">
            <Text bold color={focus === 'detail' ? 'cyan' : undefined}>{`Detail (assignmentsDir=${assignmentsDir})`}</Text>
          </Box>
        </Box>
        <Box height={actionBar.height}>
          <Text dimColor>
            {`q quit · tab focus · ${tmuxAvailable ? 'tmux ready' : 'no tmux (launch/attach limited)'}`}
          </Text>
        </Box>
      </Box>
    </MouseProvider>
  );
};
```

> **Hit-testing precision rule (applies to Tasks 11–13):** child views receive their region rect from `layout.regions` and render with explicit sizes and NO borders, so the rects they register match rendered cells exactly. If a future view needs a border, inset its registered rect by the border width.

- [ ] **Step 6: Write the shell smoke test**

```tsx
// src/tui/cockpit/__tests__/Cockpit.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Cockpit } from '../Cockpit.js';

describe('Cockpit shell', () => {
  it('renders rail + detail + status bar', () => {
    const { lastFrame } = render(<Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" tmuxAvailable={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Rail');
    expect(f).toContain('Detail');
    expect(f).toContain('no tmux');
  });
});
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run src/tui/cockpit/__tests__/`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tui/cockpit
git commit -m "feat(tui): cockpit shell + layout with region rects (columns/rows)"
```

---

### Task 11: ProjectTree controller + LeftRail (state ownership + row hit-testing)

**Files:**
- Create: `src/tui/cockpit/railTypes.ts` (shared prop types + `resolveRowIndex`)
- Create: `src/tui/cockpit/ProjectTree.tsx` (owns `useProjects` + `useTreeState`; keyboard + selection)
- Create: `src/tui/cockpit/LeftRail.tsx`
- Modify: `src/tui/cockpit/Cockpit.tsx` (mount `<LeftRail>`, poll sessions, lift selection)
- Test: `src/tui/cockpit/__tests__/rowHit.test.ts`
- Test: `src/tui/cockpit/__tests__/LeftRail.test.tsx`

**Interfaces:**
- Consumes: existing `useProjects` (`src/tui/hooks/useProjects.js`), `useTreeState` (`src/tui/hooks/useTreeState.js`), `TreeView` (`src/tui/components/TreeView.js`), `statusColors` (`src/tui/colors.js`), `loadSessions` (Task 6), `useMouseRegions` (Task 5), `Rect` (Task 4), `isMouseSequence` (Task 2).
- Produces:
  ```ts
  // railTypes.ts
  export function resolveRowIndex(rect: Rect, mouseY: number, headerRows: number): number | null;
  export interface ProjectTreeProps { projectsDir: string; active: boolean; onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void; }
  export interface LeftRailProps {
    projectsDir: string; railRect: Rect; sessions: AgentSessionWithLiveness[];
    focused: boolean; active: boolean;
    onSelectSession: (s: AgentSessionWithLiveness) => void;
    onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void;
  }
  // ProjectTree.tsx
  export const ProjectTree: React.FC<ProjectTreeProps>;
  ```

> **State ownership (fixes the ORDERING gap):** `ProjectTree` owns `useProjects` + `useTreeState` and its OWN `useInput` (gated by `active`, guarded by `isMouseSequence`) for keyboard nav — NOT the cockpit. It calls `onSelectAssignment` when an assignment row is activated. `LeftRail` renders Live Sessions above `ProjectTree`.
>
> **v1 mouse scope (deliberate cut):** Row-level mouse targeting is implemented for the **Live Sessions** list only (fixed layout above the tree → exact `resolveRowIndex`). The **assignment tree** is keyboard-navigated in v1 (arrows/enter/expand — the existing `browse` UX); mapping a click to a specific tree row would require `TreeView`'s internal viewport window (`TreeView.tsx:13` computes its own start/end), which is deferred. Mouse over the tree region supports **scroll** (moves the cursor via `useTreeState`) and **click-to-focus the rail**; precise click-to-select-tree-row is a follow-up. This keeps v1's hit-testing exact and matches Claude Code's mouse model (scroll + select), while every tree action remains keyboard-reachable. Reflect this in the assignment's acceptance criteria (tree expand/collapse is keyboard in v1).

- [ ] **Step 1: Write the failing row-hit test**

```ts
// src/tui/cockpit/__tests__/rowHit.test.ts
import { describe, it, expect } from 'vitest';
import { resolveRowIndex } from '../railTypes.js';

const rect = { x: 0, y: 0, width: 30, height: 10 };

describe('resolveRowIndex', () => {
  it('maps a click row to a 0-based index below the header rows', () => {
    expect(resolveRowIndex(rect, 2, 1)).toBe(1);
  });
  it('returns null on/above the header', () => {
    expect(resolveRowIndex(rect, 0, 1)).toBeNull();
  });
  it('returns null outside the rect vertically', () => {
    expect(resolveRowIndex(rect, 20, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/rowHit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `railTypes.ts`**

```ts
// src/tui/cockpit/railTypes.ts
import type { Rect } from '../mouse/registry.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';

export function resolveRowIndex(rect: Rect, mouseY: number, headerRows: number): number | null {
  if (mouseY < rect.y || mouseY >= rect.y + rect.height) return null;
  const idx = mouseY - rect.y - headerRows;
  return idx >= 0 ? idx : null;
}

export interface ProjectTreeProps {
  projectsDir: string;
  active: boolean;
  onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void;
}

export interface LeftRailProps {
  projectsDir: string;
  railRect: Rect;
  sessions: AgentSessionWithLiveness[];
  focused: boolean;
  active: boolean;
  onSelectSession: (s: AgentSessionWithLiveness) => void;
  onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void;
}
```

- [ ] **Step 4: Run row-hit test**

Run: `npx vitest run src/tui/cockpit/__tests__/rowHit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement `ProjectTree.tsx`**

Read `src/tui/App.tsx` first and copy its `useProjects` + `useTreeState` + `TreeView` wiring. Then: gate `useInput` on `active`; guard with `if (isMouseSequence(input)) return;`; on Enter over an assignment node call `onSelectAssignment(node.projectSlug, node.assignmentSlug)` instead of launching. Do not re-implement the hooks.

```tsx
// src/tui/cockpit/ProjectTree.tsx  (skeleton — fill nav from App.tsx)
import React from 'react';
import { useInput } from 'ink';
import { TreeView } from '../components/TreeView.js';
import { useProjects } from '../hooks/useProjects.js';
import { useTreeState } from '../hooks/useTreeState.js';
import { isMouseSequence } from '../mouse/parse.js';
import type { ProjectTreeProps } from './railTypes.js';

export const ProjectTree: React.FC<ProjectTreeProps> = ({ projectsDir, active, onSelectAssignment }) => {
  const { nodes } = useProjects(projectsDir);       // confirm useProjects return shape
  const tree = useTreeState(nodes);                  // cursor, flat, toggle, currentNode
  useInput((input, key) => {
    if (!active || isMouseSequence(input)) return;
    // Copy up/down/left/right/enter handling from App.tsx. On Enter over an
    // assignment node: onSelectAssignment(node.projectSlug, node.assignmentSlug)
  }, { isActive: active });
  return <TreeView nodes={tree.flat} cursor={tree.cursor} viewportHeight={10} />;
};
```

> Confirm the exact return shapes of `useProjects`/`useTreeState` and `FlatNode` fields (`projectSlug`, `assignmentSlug`, node kind) from `src/tui/hooks/*` and `src/tui/types.ts` before finalizing.

- [ ] **Step 6: Implement `LeftRail.tsx`**

```tsx
// src/tui/cockpit/LeftRail.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { statusColors } from '../colors.js';
import { useMouseRegions } from '../mouse/hooks.js';
import { resolveRowIndex, type LeftRailProps } from './railTypes.js';
import { ProjectTree } from './ProjectTree.js';

export const LeftRail: React.FC<LeftRailProps> = ({
  railRect, sessions, focused, active, onSelectSession, onSelectAssignment, projectsDir,
}) => {
  const HEADER_ROWS = 1; // "Live Sessions" title on row 0
  useMouseRegions([
    {
      id: 'rail-sessions',
      rect: { x: railRect.x, y: railRect.y, width: railRect.width, height: sessions.length + HEADER_ROWS },
      onClick: (e) => {
        const idx = resolveRowIndex(railRect, e.y, HEADER_ROWS);
        if (idx !== null && idx < sessions.length) onSelectSession(sessions[idx]);
      },
    },
  ]);

  return (
    <Box flexDirection="column">
      <Text bold underline color={focused ? 'cyan' : undefined}>Live Sessions</Text>
      {sessions.length === 0 ? (
        <Text dimColor>  (none)</Text>
      ) : (
        sessions.map((s) => (
          <Text key={s.sessionId}>
            <Text color={s.isLive ? 'green' : 'gray'}>{s.isLive ? '●' : '○'} </Text>
            <Text color={statusColors[s.status] ?? 'white'}>{s.agent}</Text>
            <Text dimColor> {s.sessionId.slice(0, 8)}</Text>
          </Text>
        ))
      )}
      <Box marginTop={1}><Text bold underline>Projects</Text></Box>
      <ProjectTree projectsDir={projectsDir} active={active} onSelectAssignment={onSelectAssignment} />
    </Box>
  );
};
```

- [ ] **Step 7: Write the LeftRail test**

```tsx
// src/tui/cockpit/__tests__/LeftRail.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { LeftRail } from '../LeftRail.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

const session = {
  sessionId: 's1abc999', agent: 'claude', started: '2026-07-01T00:00:00Z',
  status: 'active', isLive: true, resumeSupported: true, forkSupported: false,
  projectSlug: null, assignmentSlug: null,
} as AgentSessionWithLiveness;

describe('LeftRail', () => {
  it('renders Live Sessions + a live row', () => {
    const { lastFrame } = render(
      <MouseProvider>
        <LeftRail
          projectsDir="/tmp/p" railRect={{ x: 0, y: 0, width: 30, height: 20 }}
          sessions={[session]} focused active
          onSelectSession={vi.fn()} onSelectAssignment={vi.fn()}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('Live Sessions');
    expect(f).toContain('claude');
    expect(f).toContain('s1abc99');
  });
});
```

- [ ] **Step 8: Mount in `Cockpit.tsx`**

Replace the rail placeholder with `<LeftRail .../>`, passing `railRect={layout.regions.rail}`, `active={focus==='rail'}`. Add `sessions` state via a `useEffect` polling `loadSessions({ projectsDir, agents })` every ~1500ms (load `agents` once from `readConfig()`→`getAgents(config)` at mount, stored in state). Lift `selectedSession`/`selectedAssignment` state (consumed by Task 12).

- [ ] **Step 9: Run tests + typecheck**

Run: `npx vitest run src/tui/cockpit/__tests__/`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/tui/cockpit
git commit -m "feat(tui): ProjectTree controller + LeftRail with row-level mouse hit-testing"
```

---

### Task 12: Detail pane (assignment detail | transcript)

**Files:**
- Create: `src/tui/cockpit/acParse.ts` (pure — parse ACs from body)
- Create: `src/tui/cockpit/DetailPane.tsx`
- Modify: `src/tui/cockpit/Cockpit.tsx` (mount `<DetailPane>`)
- Test: `src/tui/cockpit/__tests__/acParse.test.ts`
- Test: `src/tui/cockpit/__tests__/DetailPane.test.tsx`

**Interfaces:**
- Consumes: `getAssignmentDetail` + `getAssignmentDetailById` (`src/dashboard/api.js`), `tailFile` (Task 7), `statusColors` (`src/tui/colors.js`), `AssignmentDetail`/`AgentSessionWithLiveness` (`src/dashboard/types.js`).
- Produces:
  ```ts
  export function parseAcceptanceCriteria(body: string): { text: string; checked: boolean }[];
  export type DetailSelection =
    | { kind: 'assignment'; projectSlug: string | null; assignmentSlug: string }
    | { kind: 'session'; session: AgentSessionWithLiveness }
    | { kind: 'none' };
  export const DetailPane: React.FC<{ projectsDir: string; assignmentsDir: string; selection: DetailSelection }>;
  ```

> **API fixes:** `getAssignmentDetail(projectsDir, projectSlug, assignmentSlug)` requires a non-null `projectSlug`; standalone selections use `getAssignmentDetailById(projectsDir, assignmentsDir, assignmentSlug)`. `AssignmentDetail` has NO `acceptanceCriteria` field — parse ACs from `detail.body`. Fields include `body`, `plan`, `scratchpad`, `handoff`, `decisionRecord` (see `src/dashboard/types.ts:242`).

- [ ] **Step 1: Write the failing AC-parse test**

```ts
// src/tui/cockpit/__tests__/acParse.test.ts
import { describe, it, expect } from 'vitest';
import { parseAcceptanceCriteria } from '../acParse.js';

const body = [
  '## Objective', 'Do the thing.', '',
  '## Acceptance Criteria', '- [ ] first', '- [x] second done', '',
  '## Context', '- [ ] not a criterion',
].join('\n');

describe('parseAcceptanceCriteria', () => {
  it('extracts only checkbox lines under the Acceptance Criteria heading', () => {
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: 'first', checked: false },
      { text: 'second done', checked: true },
    ]);
  });
  it('returns [] when the heading is absent', () => {
    expect(parseAcceptanceCriteria('## Objective\nx')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/acParse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `acParse.ts`**

```ts
// src/tui/cockpit/acParse.ts
export function parseAcceptanceCriteria(body: string): { text: string; checked: boolean }[] {
  const lines = body.split('\n');
  const out: { text: string; checked: boolean }[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = /acceptance criteria/i.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const cb = line.match(/^\s*-\s*\[( |x|X)\]\s+(.*)$/);
    if (cb) out.push({ text: cb[2].trim(), checked: cb[1].toLowerCase() === 'x' });
  }
  return out;
}
```

- [ ] **Step 4: Run AC-parse test**

Run: `npx vitest run src/tui/cockpit/__tests__/acParse.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `DetailPane.tsx`**

```tsx
// src/tui/cockpit/DetailPane.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getAssignmentDetail, getAssignmentDetailById } from '../../dashboard/api.js';
import { tailFile } from '../sessions/transcript.js';
import { statusColors } from '../colors.js';
import { parseAcceptanceCriteria } from './acParse.js';
import type { AssignmentDetail, AgentSessionWithLiveness } from '../../dashboard/types.js';

export type DetailSelection =
  | { kind: 'assignment'; projectSlug: string | null; assignmentSlug: string }
  | { kind: 'session'; session: AgentSessionWithLiveness }
  | { kind: 'none' };

const MAX_VISIBLE = 200;

function AssignmentView({
  projectsDir, assignmentsDir, projectSlug, assignmentSlug,
}: { projectsDir: string; assignmentsDir: string; projectSlug: string | null; assignmentSlug: string }) {
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  useEffect(() => {
    let alive = true;
    const p = projectSlug
      ? getAssignmentDetail(projectsDir, projectSlug, assignmentSlug)
      : getAssignmentDetailById(projectsDir, assignmentsDir, assignmentSlug);
    p.then((d) => { if (alive) setDetail(d); });
    return () => { alive = false; };
  }, [projectsDir, assignmentsDir, projectSlug, assignmentSlug]);

  if (!detail) return <Text dimColor>Loading…</Text>;
  const acs = parseAcceptanceCriteria(detail.body);
  return (
    <Box flexDirection="column">
      <Text bold>{detail.title}</Text>
      <Text>Status: <Text color={statusColors[detail.status] ?? 'white'}>{detail.status}</Text></Text>
      {acs.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold underline>Acceptance Criteria</Text>
          {acs.map((c, i) => (<Text key={i}>{c.checked ? '☑' : '☐'} {c.text}</Text>))}
        </Box>
      )}
      {detail.plan && (
        <Box marginTop={1}><Text dimColor>plan: {detail.plan.status} (updated {detail.plan.updated})</Text></Box>
      )}
    </Box>
  );
}

function TranscriptView({ session }: { session: AgentSessionWithLiveness }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    setLines([]);
    if (!session.transcriptPath) { setLines(['(no transcript available)']); return; }
    const h = tailFile({
      path: session.transcriptPath,
      onLines: (ls) => setLines((prev) => [...prev, ...ls].slice(-MAX_VISIBLE)),
      onError: (e) => setLines([`(transcript error: ${e.message})`]),
    });
    return () => h.stop();
  }, [session.sessionId, session.transcriptPath]);
  return (<Box flexDirection="column">{lines.map((l, i) => <Text key={i}>{l}</Text>)}</Box>);
}

export const DetailPane: React.FC<{ projectsDir: string; assignmentsDir: string; selection: DetailSelection }> = ({
  projectsDir, assignmentsDir, selection,
}) => {
  if (selection.kind === 'none') return <Text dimColor>Select an assignment or session (↑/↓, click)</Text>;
  if (selection.kind === 'assignment')
    return <AssignmentView projectsDir={projectsDir} assignmentsDir={assignmentsDir} projectSlug={selection.projectSlug} assignmentSlug={selection.assignmentSlug} />;
  return <TranscriptView session={selection.session} />;
};
```

> Confirm `AgentSessionWithLiveness` exposes `transcriptPath` (via `AgentSession`) before finalizing `TranscriptView`; adapt if named differently.

- [ ] **Step 6: Write DetailPane empty-state test**

```tsx
// src/tui/cockpit/__tests__/DetailPane.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DetailPane } from '../DetailPane.js';

describe('DetailPane', () => {
  it('shows a hint when nothing is selected', () => {
    const { lastFrame } = render(
      <DetailPane projectsDir="/tmp/p" assignmentsDir="/tmp/a" selection={{ kind: 'none' }} />,
    );
    expect(lastFrame() ?? '').toContain('Select an assignment or session');
  });
});
```

- [ ] **Step 7: Mount in `Cockpit.tsx`**

Replace the detail placeholder with `<DetailPane projectsDir={projectsDir} assignmentsDir={assignmentsDir} selection={selection} />`. Derive `selection` from lifted state (session wins when set; else assignment; else none).

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run src/tui/cockpit/__tests__/`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tui/cockpit
git commit -m "feat(tui): detail pane (assignment detail w/ AC parse | transcript tail)"
```

---

### Task 13: Action bar with clickable actions

**Files:**
- Create: `src/tui/cockpit/ActionBar.tsx`
- Modify: `src/tui/cockpit/Cockpit.tsx` (replace inline status bar)
- Test: `src/tui/cockpit/__tests__/ActionBar.test.tsx`

**Interfaces:**
- Consumes: `useMouseRegions` (Task 5), `Rect` (Task 4).
- Produces:
  ```ts
  export interface Action { key: string; label: string; onRun: () => void; enabled: boolean; }
  export const ActionBar: React.FC<{ actions: Action[]; barRect: Rect }>;
  ```
  Each action gets a mouse region within `barRect`, laid out left-to-right; disabled actions render greyed and ignore clicks.

- [ ] **Step 1: Write the failing test**

```tsx
// src/tui/cockpit/__tests__/ActionBar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { ActionBar } from '../ActionBar.js';

describe('ActionBar', () => {
  it('renders enabled + disabled actions with key hints', () => {
    const { lastFrame } = render(
      <MouseProvider>
        <ActionBar
          barRect={{ x: 0, y: 23, width: 80, height: 1 }}
          actions={[
            { key: 'l', label: 'Launch', onRun: vi.fn(), enabled: true },
            { key: 'a', label: 'Attach', onRun: vi.fn(), enabled: false },
          ]}
        />
      </MouseProvider>,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('Launch');
    expect(f).toContain('Attach');
    expect(f).toContain('l');
    expect(f).toContain('a');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/ActionBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/tui/cockpit/ActionBar.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { useMouseRegions } from '../mouse/hooks.js';
import type { Rect } from '../mouse/registry.js';

export interface Action { key: string; label: string; onRun: () => void; enabled: boolean; }

// rendered as "[k] Label" + 2-col gap
function cellWidth(label: string): number {
  return 3 + 1 + label.length + 2;
}

export const ActionBar: React.FC<{ actions: Action[]; barRect: Rect }> = ({ actions, barRect }) => {
  let x = barRect.x;
  const regions = actions.map((a) => {
    const width = cellWidth(a.label);
    const rect: Rect = { x, y: barRect.y, width, height: 1 };
    x += width;
    return { id: `action-${a.key}`, rect, onClick: () => { if (a.enabled) a.onRun(); } };
  });
  useMouseRegions(regions);

  return (
    <Box>
      {actions.map((a) => (
        <Box key={a.key} marginRight={2}>
          <Text dimColor={!a.enabled}>
            <Text color={a.enabled ? 'cyan' : 'gray'}>[{a.key}]</Text> {a.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
};
```

- [ ] **Step 4: Wire into `Cockpit.tsx`**

Replace the inline status `<Text>` with `<ActionBar actions={actions} barRect={layout.regions.actionBar} />`. Build `actions` from selection + `tmuxAvailable` (enable conditions per Task 15's nullability guards): `Launch` (enabled when an assignment is selected AND its `projectSlug` is non-null), `Attach` (enabled when a live session is selected AND `tmuxAvailable` AND `session.assignmentSlug` is non-null), `Quit` (always). Route each `key` through the cockpit `useInput` (with the `isMouseSequence` guard) for keyboard parity.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/tui/cockpit/__tests__/`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/cockpit
git commit -m "feat(tui): clickable action bar (layout regions) with keyboard parity"
```

---

### Task 14: `syntaur tui` command + bootstrap

**Files:**
- Create: `src/commands/tui.ts`
- Modify: `src/index.ts` (register via commander)
- Test: `src/commands/__tests__/tui.test.ts`

**Interfaces:**
- Consumes: `readConfig`/`getAgents` (`src/utils/config.js`), `initSessionDb` (`src/dashboard/session-db.js`), `checkTmuxAvailable` (`src/dashboard/scanner.js`), the standalone assignments-dir path helper (`src/utils/paths.js` — confirm export), `runCommand` (`src/errors.js`), `Cockpit` (Task 10), Ink `render` with `{ alternateScreen: true }`.
- Produces:
  ```ts
  export interface CockpitRenderProps { projectsDir: string; assignmentsDir: string; tmuxAvailable: boolean; }
  export async function buildTuiRenderProps(deps: { config: SyntaurConfig; assignmentsDir: string; checkTmux: () => Promise<boolean>; }): Promise<CockpitRenderProps>;
  export async function tuiCommand(): Promise<void>;
  ```

- [ ] **Step 1: Write the failing bootstrap test**

```ts
// src/commands/__tests__/tui.test.ts
import { describe, it, expect } from 'vitest';
import { buildTuiRenderProps } from '../tui.js';

describe('tui bootstrap', () => {
  it('derives cockpit props from config + tmux probe', async () => {
    const props = await buildTuiRenderProps({
      config: { defaultProjectDir: '/tmp/projects' } as never,
      assignmentsDir: '/tmp/assignments',
      checkTmux: async () => true,
    });
    expect(props).toEqual({ projectsDir: '/tmp/projects', assignmentsDir: '/tmp/assignments', tmuxAvailable: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/commands/__tests__/tui.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/commands/tui.ts
import React from 'react';
import { readConfig, getAgents, type SyntaurConfig } from '../utils/config.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { checkTmuxAvailable } from '../dashboard/scanner.js';
import { assignmentsDir as resolveAssignmentsDir } from '../utils/paths.js'; // confirm exact export name

export interface CockpitRenderProps {
  projectsDir: string;
  assignmentsDir: string;
  tmuxAvailable: boolean;
}

export async function buildTuiRenderProps(deps: {
  config: SyntaurConfig;
  assignmentsDir: string;
  checkTmux: () => Promise<boolean>;
}): Promise<CockpitRenderProps> {
  return {
    projectsDir: deps.config.defaultProjectDir,
    assignmentsDir: deps.assignmentsDir,
    tmuxAvailable: await deps.checkTmux(),
  };
}

export async function tuiCommand(): Promise<void> {
  const config = await readConfig();
  initSessionDb();
  const props = await buildTuiRenderProps({
    config,
    assignmentsDir: resolveAssignmentsDir(),
    checkTmux: checkTmuxAvailable,
  });

  const { render } = await import('ink');
  const { Cockpit } = await import('../tui/cockpit/Cockpit.js');
  const instance = render(React.createElement(Cockpit, props), { alternateScreen: true });
  await instance.waitUntilExit();
}
```

> `getAgents` is imported for the Cockpit's session polling (loaded inside `Cockpit`). Confirm the standalone assignments-dir export in `src/utils/paths.ts` (used elsewhere as `~/.syntaur/assignments`); adjust the import name if different.

- [ ] **Step 4: Register in `src/index.ts`**

Add with the other command imports: `import { tuiCommand } from './commands/tui.js';` and register mirroring existing commands (`.action(runCommand(...))` — `runCommand` RETURNS the handler):

```ts
program
  .command('tui')
  .description('Open the fullscreen agent cockpit (browse, launch, monitor, attach)')
  .action(runCommand(async () => { await tuiCommand(); }));
```

- [ ] **Step 5: Test + build + smoke**

Run: `npx vitest run src/commands/__tests__/tui.test.ts`
Expected: PASS.
Run: `npm run build && node bin/syntaur.js tui`
Expected: fullscreen cockpit opens; `q` exits; terminal restored (no mouse-report garbage, scrollback intact — verifies `alternateScreen` + MouseProvider teardown).

- [ ] **Step 6: Commit**

```bash
git add src/commands/tui.ts src/commands/__tests__/tui.test.ts src/index.ts
git commit -m "feat(tui): syntaur tui command + alternateScreen bootstrap"
```

---

### Task 15: Wire launch + attach (context helper, suspendTerminal, degradation)

**Files:**
- Create: `src/launch/build-launch.ts` (extract the reusable "resolve cwd + write context.json + build argv/prompt" path from `launchAgent`, returning data without spawning)
- Create: `src/tui/cockpit/actions.ts` (launch orchestration — testable)
- Modify: `src/tui/launch.ts` (refactor `launchAgent` to consume `build-launch.ts`; keep its tests green)
- Modify: `src/tui/cockpit/Cockpit.tsx` (invoke actions from ActionBar/keys via `suspendTerminal`)
- Test: `src/tui/cockpit/__tests__/actions.test.ts`
- Test: `src/launch/__tests__/build-launch.test.ts`

**Interfaces:**
- Consumes: `buildAgentArgv` + existing cwd/prompt helpers (`src/tui/launch.js`, `src/launch/*`), `launchInTmux`/`tmuxSessionName`/`tmuxSessionExists` (Task 8), `runTmuxAttach` (Task 9), Ink `useApp().suspendTerminal`.
- Produces:
  ```ts
  // build-launch.ts — mirror launchAgent's real inputs: projectSlug is NON-null
  // (launch.ts:28 `projectSlug: string`) and cwdOverride is preserved (launch.ts:31).
  export interface LaunchPlan { command: string; args: string[]; cwd: string; }
  export async function buildLaunchPlan(input: { projectsDir: string; projectSlug: string; assignmentSlug: string; agent: AgentConfig; cwdOverride?: string; }): Promise<LaunchPlan>;
  // actions.ts
  export interface LaunchDeps { tmuxAvailable: boolean; launchInTmux: typeof import('../tmux/launch.js').launchInTmux; handOff: (plan: { command: string; args: string[]; cwd: string }) => Promise<void>; }
  export async function runLaunch(sessionName: string, plan: { command: string; args: string[]; cwd: string }, deps: LaunchDeps): Promise<'tmux' | 'handoff'>;
  ```

> **Ordering fix:** `build-launch.ts` extracts the context/argv path so BOTH tmux launch and hand-off reuse it; `launchAgent` is refactored to call it (its existing tests must stay green — including the `cwdOverride` path at `launch-tui.test.ts`). **Attach identity:** derive the tmux session name with `tmuxSessionName(session.projectSlug, session.assignmentSlug)` — the same function used at launch.
> **Nullability guards (v1):** `AgentSession.projectSlug`/`assignmentSlug` are nullable (`types.ts:697-699`) and `launchAgent`/`getAssignmentDetail` require a NON-null `projectSlug`. Therefore: **Launch** is enabled only for a project-nested assignment selection (non-null `projectSlug`); standalone-assignment launch is deferred (button disabled with a tooltip). **Attach** is enabled only when the live session has a non-null `assignmentSlug` (and tmux is available); otherwise the button is disabled. Known limitation (log it): two live sessions for one assignment collide on tmux name; v1 targets the existing session.

- [ ] **Step 1: Write the failing actions test**

```ts
// src/tui/cockpit/__tests__/actions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runLaunch } from '../actions.js';

const plan = { command: 'claude', args: ['hi'], cwd: '/x' };

describe('runLaunch degradation', () => {
  it('uses tmux when available', async () => {
    const launchInTmux = vi.fn(async () => {});
    const handOff = vi.fn(async () => {});
    expect(await runLaunch('syntaur-p-a', plan, { tmuxAvailable: true, launchInTmux, handOff })).toBe('tmux');
    expect(launchInTmux).toHaveBeenCalledOnce();
    expect(handOff).not.toHaveBeenCalled();
  });
  it('falls back to hand-off without tmux', async () => {
    const launchInTmux = vi.fn(async () => {});
    const handOff = vi.fn(async () => {});
    expect(await runLaunch('syntaur-p-a', plan, { tmuxAvailable: false, launchInTmux, handOff })).toBe('handoff');
    expect(handOff).toHaveBeenCalledOnce();
    expect(launchInTmux).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `actions.ts`**

```ts
// src/tui/cockpit/actions.ts
import type { launchInTmux as LaunchInTmux } from '../tmux/launch.js';

export interface LaunchDeps {
  tmuxAvailable: boolean;
  launchInTmux: typeof LaunchInTmux;
  handOff: (plan: { command: string; args: string[]; cwd: string }) => Promise<void>;
}

export async function runLaunch(
  sessionName: string,
  plan: { command: string; args: string[]; cwd: string },
  deps: LaunchDeps,
): Promise<'tmux' | 'handoff'> {
  if (deps.tmuxAvailable) {
    await deps.launchInTmux({ sessionName, cwd: plan.cwd, command: plan.command, args: plan.args });
    return 'tmux';
  }
  await deps.handOff(plan);
  return 'handoff';
}
```

- [ ] **Step 4: Extract `build-launch.ts` + refactor `launchAgent`**

Read `src/tui/launch.ts:166-272` (the `launchAgent` body up to the spawn) and move the "resolve worktree/cwd → write `context.json` → resolve prompt → `buildAgentArgv`" sequence into `buildLaunchPlan` in `src/launch/build-launch.ts`, returning `{ command, args, cwd }` (the resolved spawn cwd). Rewrite `launchAgent` to `const plan = await buildLaunchPlan(...)` then its existing spawn/exit. Add a focused `build-launch.test.ts` asserting it writes `context.json` and returns the expected argv (reuse the `spawnFn`/temp-dir patterns from the existing launch tests). Run existing launch tests:

Run: `npx vitest run src/tui src/launch`
Expected: PASS (existing launch tests + new build-launch test — no regression).

- [ ] **Step 5: Run actions test**

Run: `npx vitest run src/tui/cockpit/__tests__/actions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire into `Cockpit.tsx`**

- **Launch (key `l` / Launch button — enabled only when the selected assignment has a non-null `projectSlug`):** resolve the assignment's agent (v1: default agent or first from `getAgents`), `const plan = await buildLaunchPlan({ projectsDir, projectSlug, assignmentSlug, agent })`, `const name = tmuxSessionName(projectSlug, assignmentSlug)`, then `runLaunch(name, plan, { tmuxAvailable, launchInTmux, handOff })`. For `handOff`, wrap in `suspendTerminal(async () => { /* spawn plan inherit, await exit */ })` then `exit()` the cockpit. Show a transient status line with the resulting mode.
- **Attach (key `a` / Attach button — enabled only when a live session is selected, `tmuxAvailable`, AND `session.assignmentSlug != null`):** `const name = tmuxSessionName(session.projectSlug, session.assignmentSlug)`; if `await tmuxSessionExists(name)` then `await suspendTerminal(async () => { await runTmuxAttach(name); })`; else show "session window not found". `suspendTerminal` leaves/restores the alt-screen; the MouseProvider re-enables tracking on re-render.

- [ ] **Step 7: Full verification + commit**

```bash
npm run build && npm run typecheck && npm run build --prefix dashboard && npx vitest run
```
Expected: build + typecheck clean, full suite green.
Manual smoke (tmux present): `syntaur tui` → select assignment → `l` → detached tmux session appears (`tmux ls`), cockpit stays resident, session in Live Sessions; select it → `a` → attach; detach (`Ctrl-b d`) → cockpit resumes, terminal clean.
Manual smoke (tmux hidden from PATH): Attach greyed; `l` falls back to hand-off (cockpit suspends into the agent).

```bash
git add src/launch/build-launch.ts src/launch/__tests__/build-launch.test.ts src/tui/launch.ts src/tui/cockpit
git commit -m "feat(tui): wire launch (tmux + hand-off) and attach via suspendTerminal"
```

---

## Self-Review

**1. Spec coverage:** alt-screen + restore → Tasks 1, 5 (teardown), 14 (`alternateScreen`); mouse click/scroll → Tasks 2–5, regions in 10/11/13; browse tree → Task 11 (ProjectTree owns state); assignment detail (ACs from body) → Task 12; live monitoring + liveness + transcript → Tasks 6, 7, 12; launch into tmux + hand-off → Tasks 8, 15; attach/detach via suspendTerminal → Tasks 9, 15; keyboard parity → Tasks 10, 11, 13, 15; tmux-optional degradation → Tasks 8, 13, 15; no browse regression → Task 1 Step 3. ✅

**2. Placeholder scan:** Remaining `>` notes are **verify-exact-symbol** gates against existing code (`useProjects`/`useTreeState` shapes, `paths.ts` assignments-dir export, `transcriptPath` field), each naming the file to read — not deferred work. All code steps carry full code.

**3. Type consistency:** `MouseEvent`/`MouseParser`/`isMouseSequence` (2) consumed unchanged by registry (4), provider (5), cockpit/tree (10/11/13). `Region`/`Rect` (4) used by `useMouseRegions` (5) and every view. `statusColors` (record) in 11/12. `AgentSessionWithLiveness` in 6/11/12/15. `tmuxSessionName`/`launchInTmux`/`tmuxSessionExists` (8) reused by 15; `runTmuxAttach` (9) by 15. `computeLayout`→`CockpitLayout.regions` (10) consumed by 11/13. `DetailSelection` (12) referenced by cockpit state. `buildLaunchPlan`→`LaunchPlan{command,args,cwd}` (15) consumed by `runLaunch`.

**Cross-cutting note:** Tasks 10–13, 15 each modify `Cockpit.tsx` incrementally — read the current file and integrate, don't overwrite. Lifted state (`sessions`, `selectedSession`, `selectedAssignment`, `agents`) is introduced in Task 11 Step 8 and consumed by 12/13/15. Every `useInput` in the cockpit/tree MUST early-return on `isMouseSequence(input)`.
