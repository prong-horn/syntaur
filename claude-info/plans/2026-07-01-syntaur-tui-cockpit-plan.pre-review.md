# Syntaur Agent Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a resident, fullscreen, mouse-driven Ink TUI (`syntaur tui`) that browses projects/assignments, launches agents (into tmux), and monitors/attaches to live agent sessions.

**Architecture:** Grow the existing Ink/React TUI (`src/tui/`). Add three owned subsystems — a mouse input layer (SGR 1006 parse + hit-test registry), a session feed (reusing `listAllSessions`/`enrichSessions`), and a tmux launch/attach layer — then compose them into a fullscreen alternate-screen cockpit shell. Everything degrades gracefully without tmux.

**Tech Stack:** TypeScript (ESM), Node ≥20, Ink 7 + React 19, `commander`, `better-sqlite3`, `chokidar`, `vitest` + `ink-testing-library`, `tsup` build.

**Design spec:** `claude-info/plans/2026-07-01-syntaur-tui-cockpit-design.md`

## Global Constraints

- **Runtime:** Node `>=20`, ES modules only (`.js` import specifiers in TS source).
- **Ink version:** upgrade to `ink@^7` (needed for alternate-screen render, `useBoxMetrics`, `useWindowSize`). React stays `19`.
- **No new heavy deps.** `chokidar` and `better-sqlite3` are already dependencies; the mouse layer is hand-written (no `ink-mouse` — archived).
- **No regression to `browse`.** The existing `syntaur browse` command and `src/tui/` components must keep working after the Ink 7 bump.
- **Keyboard parity.** Every mouse action must have a keyboard equivalent.
- **tmux is optional.** Browse + monitor must work with no tmux installed; launch falls back to the existing hand-off spawn; attach is disabled.
- **Testing:** `vitest`. Prefer pure functions with injectable dependency seams (mirror the existing `LivenessDeps` and `launch.ts` `spawnFn` patterns). Component tests use `ink-testing-library`.
- **Test-file typecheck blindspot:** `tsconfig` excludes test dirs, so type errors in tests are invisible to `npm run typecheck` and vitest — after any signature change, run a type-aware `tsc` probe over the touched test files.
- **Fresh worktree setup:** root `npm install` + root `npm run build` + `npm install --prefix dashboard` before `npm test` will pass.
- **Commit style:** conventional commits; commit at the end of each task.

---

### Task 1: Upgrade Ink 6.8 → 7 and pin the API surface

**Files:**
- Modify: `package.json` (dependency `ink`)
- Verify (read-only): `node_modules/ink/build/index.d.ts`
- Smoke: `src/commands/browse.ts` (no code change; just run it)

**Interfaces:**
- Produces: confirmed Ink 7 names used by later tasks — the `render()` fullscreen/alternate-screen option, `useBoxMetrics(ref)` return shape, `useWindowSize()` return shape, `useStdin()` (`stdin`, `setRawMode`, `isRawModeSupported`), and `measureElement`/`DOMElement` from `ink`.

- [ ] **Step 1: Bump the dependency**

Edit `package.json`: change `"ink": "^6.8.0"` to `"ink": "^7.0.0"`. Then:

```bash
cd /Users/brennen/syntaur && npm install
```
Expected: installs ink 7.x, no peer-dependency errors against `react@19`.

- [ ] **Step 2: Record the exact Ink 7 API names (anti-hallucination gate)**

Read the installed types and confirm the real names/signatures before any later task uses them:

```bash
grep -nE "useBoxMetrics|useWindowSize|useStdin|measureElement|fullscreen|altScreen|alternate" node_modules/ink/build/index.d.ts
```
Expected: locate the fullscreen/alternate-screen `render` option name and the three hooks. **If a name differs from this plan (e.g. the render option is `fullscreen` vs `altScreen`), use the real name from the types and note the correction at the top of any task that references it.** Do not invent names.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (tsup emits `dist/`).

- [ ] **Step 4: Smoke-test the existing TUI**

Run: `node bin/syntaur.js browse`
Expected: the current tree TUI renders and responds to `↑/↓/j/k`, `/` search, and `q` to quit — unchanged. If Ink 7 broke a prop (e.g. a removed `<Text>`/`<Box>` prop), fix the minimal usage in `src/tui/` to restore parity.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck && npm run build --prefix dashboard
git add package.json package-lock.json src/tui
git commit -m "chore(tui): upgrade ink 6.8 -> 7 for alt-screen + mouse metrics"
```

---

### Task 2: Mouse escape-sequence parser (pure)

**Files:**
- Create: `src/tui/mouse/parse.ts`
- Test: `src/tui/mouse/__tests__/parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MouseButton = 'left' | 'middle' | 'right' | 'none';
  export type MouseAction = 'down' | 'up' | 'move' | 'scroll-up' | 'scroll-down';
  export interface MouseEvent { x: number; y: number; button: MouseButton; action: MouseAction; }
  export function parseMouseEvents(chunk: string): MouseEvent[];
  ```
  `x`/`y` are 0-indexed (terminal reports 1-indexed; parser subtracts 1).

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/mouse/__tests__/parse.test.ts
import { describe, it, expect } from 'vitest';
import { parseMouseEvents } from '../parse.js';

describe('parseMouseEvents (SGR 1006)', () => {
  it('parses a left button press: ESC [ < 0 ; 12 ; 5 M', () => {
    const evts = parseMouseEvents('\x1b[<0;12;5M');
    expect(evts).toEqual([{ x: 11, y: 4, button: 'left', action: 'down' }]);
  });

  it('parses a left button release (lowercase m)', () => {
    const evts = parseMouseEvents('\x1b[<0;12;5m');
    expect(evts).toEqual([{ x: 11, y: 4, button: 'left', action: 'up' }]);
  });

  it('parses scroll up (64) and scroll down (65)', () => {
    expect(parseMouseEvents('\x1b[<64;3;3M')[0].action).toBe('scroll-up');
    expect(parseMouseEvents('\x1b[<65;3;3M')[0].action).toBe('scroll-down');
  });

  it('parses right button (2) and middle (1)', () => {
    expect(parseMouseEvents('\x1b[<2;1;1M')[0].button).toBe('right');
    expect(parseMouseEvents('\x1b[<1;1;1M')[0].button).toBe('middle');
  });

  it('parses a motion event (button code with 32 drag bit) as move', () => {
    expect(parseMouseEvents('\x1b[<35;9;9M')[0].action).toBe('move');
  });

  it('parses multiple events in one chunk and ignores non-mouse bytes', () => {
    const evts = parseMouseEvents('x\x1b[<0;1;1M\x1b[<0;1;1my');
    expect(evts.map((e) => e.action)).toEqual(['down', 'up']);
  });

  it('returns [] for a chunk with no mouse sequences', () => {
    expect(parseMouseEvents('hello')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/mouse/__tests__/parse.test.ts`
Expected: FAIL — cannot find module `../parse.js`.

- [ ] **Step 3: Implement the parser**

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

// SGR 1006 mouse reports: ESC [ < Cb ; Cx ; Cy (M|m)
// M = press/motion, m = release. Coordinates are 1-indexed.
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

const SCROLL_UP = 64;
const SCROLL_DOWN = 65;
const MOTION_BIT = 32; // drag / move
const BUTTON_MASK = 0b11; // low two bits select the button

function toButton(cb: number): MouseButton {
  if (cb & SCROLL_UP || cb & SCROLL_DOWN) return 'none';
  switch (cb & BUTTON_MASK) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return 'none';
  }
}

export function parseMouseEvents(chunk: string): MouseEvent[] {
  const out: MouseEvent[] = [];
  SGR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR_RE.exec(chunk)) !== null) {
    const cb = Number(m[1]);
    const x = Number(m[2]) - 1;
    const y = Number(m[3]) - 1;
    const isRelease = m[4] === 'm';

    let action: MouseAction;
    if (cb === SCROLL_UP) action = 'scroll-up';
    else if (cb === SCROLL_DOWN) action = 'scroll-down';
    else if (cb & MOTION_BIT) action = 'move';
    else action = isRelease ? 'up' : 'down';

    out.push({ x, y, button: toButton(cb), action });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/mouse/__tests__/parse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/mouse/parse.ts src/tui/mouse/__tests__/parse.test.ts
git commit -m "feat(tui): SGR 1006 mouse escape-sequence parser"
```

---

### Task 2b: Split parser gate — none

(Task 2 is a single deliverable; no split.)

---

### Task 3: Mouse tracking enable/disable

**Files:**
- Create: `src/tui/mouse/tracking.ts`
- Test: `src/tui/mouse/__tests__/tracking.test.ts`

**Interfaces:**
- Consumes: nothing.
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
  it('enable writes the button + drag + SGR-encoding enable sequences', () => {
    let buf = '';
    enableMouseTracking((s) => (buf += s));
    // 1000 = button events, 1002 = drag, 1006 = SGR extended coords
    expect(buf).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  });

  it('disable writes the matching reset sequences in reverse', () => {
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
// SGR 1006 mouse tracking. 1000 = normal button tracking, 1002 = button-event
// (drag) tracking, 1006 = SGR extended coordinate encoding (needed for
// terminals wider/taller than 223 cells). Enable low->high, disable high->low.
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
git commit -m "feat(tui): enable/disable SGR mouse tracking sequences"
```

---

### Task 4: Hit-test registry (pure)

**Files:**
- Create: `src/tui/mouse/registry.ts`
- Test: `src/tui/mouse/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `MouseEvent` from `./parse.js`.
- Produces:
  ```ts
  export interface Rect { x: number; y: number; width: number; height: number; }
  export interface Region {
    id: string;
    rect: Rect;
    onClick?: (e: MouseEvent) => void;
    onScroll?: (e: MouseEvent) => void;
    z?: number; // higher wins on overlap; default 0
  }
  export class HitRegistry {
    set(region: Region): void;      // upsert by id
    remove(id: string): void;
    dispatch(e: MouseEvent): boolean; // true if a handler fired
    clear(): void;
  }
  export function rectContains(rect: Rect, x: number, y: number): boolean;
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
  it('fires onClick for a down event inside a region', () => {
    const r = new HitRegistry();
    const spy = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 10, height: 2 }, onClick: spy });
    expect(r.dispatch(at(3, 1))).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('does not fire for a down event outside every region', () => {
    const r = new HitRegistry();
    const spy = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 2, height: 2 }, onClick: spy });
    expect(r.dispatch(at(9, 9))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes scroll events to onScroll, not onClick', () => {
    const r = new HitRegistry();
    const click = vi.fn();
    const scroll = vi.fn();
    r.set({ id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: click, onScroll: scroll });
    r.dispatch(at(1, 1, 'scroll-down'));
    expect(scroll).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });

  it('on overlap, the higher-z region wins', () => {
    const r = new HitRegistry();
    const lo = vi.fn();
    const hi = vi.fn();
    r.set({ id: 'lo', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: lo, z: 0 });
    r.set({ id: 'hi', rect: { x: 0, y: 0, width: 10, height: 10 }, onClick: hi, z: 5 });
    r.dispatch(at(2, 2));
    expect(hi).toHaveBeenCalledOnce();
    expect(lo).not.toHaveBeenCalled();
  });

  it('remove() unregisters a region', () => {
    const r = new HitRegistry();
    const spy = vi.fn();
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
  return (
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
  );
}

export class HitRegistry {
  private regions = new Map<string, Region>();

  set(region: Region): void {
    this.regions.set(region.id, region);
  }

  remove(id: string): void {
    this.regions.delete(id);
  }

  clear(): void {
    this.regions.clear();
  }

  dispatch(e: MouseEvent): boolean {
    const hits = [...this.regions.values()]
      .filter((r) => rectContains(r.rect, e.x, e.y))
      .sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
    const target = hits[0];
    if (!target) return false;

    if (e.action === 'scroll-up' || e.action === 'scroll-down') {
      if (target.onScroll) {
        target.onScroll(e);
        return true;
      }
      return false;
    }
    // Treat a button 'down' as the click trigger (release is ignored to avoid
    // double-firing; move events never trigger click handlers).
    if (e.action === 'down' && target.onClick) {
      target.onClick(e);
      return true;
    }
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
git commit -m "feat(tui): hit-test registry with z-ordering and scroll routing"
```

---

### Task 5: Mouse React layer (Provider + hooks + components)

**Files:**
- Create: `src/tui/mouse/MouseContext.tsx` (context + `<MouseProvider>`)
- Create: `src/tui/mouse/hooks.ts` (`useClick`, `useScroll`)
- Create: `src/tui/mouse/components.tsx` (`<Clickable>`, `<Scrollable>`)
- Test: `src/tui/mouse/__tests__/MouseProvider.test.tsx`

**Interfaces:**
- Consumes: `parseMouseEvents` (Task 2), `enable/disableMouseTracking` (Task 3), `HitRegistry`/`Region`/`Rect` (Task 4); Ink 7 `useStdin`, `useBoxMetrics`, `measureElement`, `DOMElement` (names confirmed in Task 1 Step 2).
- Produces:
  ```ts
  // MouseContext.tsx
  export const MouseProvider: React.FC<{ children: React.ReactNode }>;
  export function useHitRegistry(): HitRegistry;
  // hooks.ts
  export function useClick(ref: React.RefObject<DOMElement>, onClick: () => void, opts?: { z?: number }): void;
  export function useScroll(ref: React.RefObject<DOMElement>, onScroll: (dir: 'up' | 'down') => void, opts?: { z?: number }): void;
  // components.tsx
  export const Clickable: React.FC<{ onClick: () => void; z?: number; children: React.ReactNode } & BoxProps>;
  export const Scrollable: React.FC<{ onScroll: (dir: 'up' | 'down') => void; z?: number; children: React.ReactNode } & BoxProps>;
  ```

> **Note (Task 1 dependency):** `useBoxMetrics`/`measureElement` return a rect with `{ x, y, width, height }` in absolute terminal coordinates. Confirm the exact property names from the Ink 7 types recorded in Task 1 Step 2 and adapt the mapping in `useClick`/`useScroll` if they differ (e.g. `left/top` vs `x/y`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/tui/mouse/__tests__/MouseProvider.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { MouseProvider, useHitRegistry } from '../MouseContext.js';

// A probe that registers a region directly on the shared registry, then asserts
// a synthesized click dispatches to it — proving the Provider wires a registry
// that components can reach.
function Probe({ onHit }: { onHit: () => void }) {
  const registry = useHitRegistry();
  React.useEffect(() => {
    registry.set({ id: 'probe', rect: { x: 0, y: 0, width: 5, height: 1 }, onClick: onHit });
    // simulate the Provider receiving a mouse-down at (2,0)
    registry.dispatch({ x: 2, y: 0, button: 'left', action: 'down' });
  }, [registry, onHit]);
  return <Text>probe</Text>;
}

describe('MouseProvider', () => {
  it('provides a HitRegistry that descendants can register on and dispatch through', () => {
    const onHit = vi.fn();
    render(
      <MouseProvider>
        <Probe onHit={onHit} />
      </MouseProvider>,
    );
    expect(onHit).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/mouse/__tests__/MouseProvider.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the context/provider**

```tsx
// src/tui/mouse/MouseContext.tsx
import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useStdin, useStdout } from 'ink';
import { HitRegistry } from './registry.js';
import { parseMouseEvents } from './parse.js';
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
    if (!isRawModeSupported || !stdin) return; // no TTY -> keyboard-only, no crash
    setRawMode(true);
    enableMouseTracking((s) => write(s));

    const onData = (data: Buffer | string) => {
      const chunk = typeof data === 'string' ? data : data.toString('utf8');
      for (const evt of parseMouseEvents(chunk)) registry.dispatch(evt);
    };
    stdin.on('data', onData);

    return () => {
      stdin.off('data', onData);
      disableMouseTracking((s) => write(s));
    };
  }, [stdin, setRawMode, isRawModeSupported, write, registry]);

  return <MouseCtx.Provider value={registry}>{children}</MouseCtx.Provider>;
};
```

- [ ] **Step 4: Implement the hooks**

```ts
// src/tui/mouse/hooks.ts
import { useEffect, useId } from 'react';
import { measureElement, type DOMElement } from 'ink';
import { useHitRegistry } from './MouseContext.js';

// measureElement returns { width, height, x, y } in absolute coords (confirm
// exact keys against Ink 7 types from Task 1 Step 2).
function measure(ref: React.RefObject<DOMElement>) {
  if (!ref.current) return null;
  const m = measureElement(ref.current) as { x: number; y: number; width: number; height: number };
  return { x: m.x, y: m.y, width: m.width, height: m.height };
}

export function useClick(
  ref: React.RefObject<DOMElement>,
  onClick: () => void,
  opts?: { z?: number },
): void {
  const registry = useHitRegistry();
  const id = useId();
  useEffect(() => {
    const rect = measure(ref);
    if (!rect) return;
    registry.set({ id, rect, z: opts?.z, onClick: () => onClick() });
    return () => registry.remove(id);
  });
}

export function useScroll(
  ref: React.RefObject<DOMElement>,
  onScroll: (dir: 'up' | 'down') => void,
  opts?: { z?: number },
): void {
  const registry = useHitRegistry();
  const id = useId();
  useEffect(() => {
    const rect = measure(ref);
    if (!rect) return;
    registry.set({
      id,
      rect,
      z: opts?.z,
      onScroll: (e) => onScroll(e.action === 'scroll-up' ? 'up' : 'down'),
    });
    return () => registry.remove(id);
  });
}
```

- [ ] **Step 5: Implement the components**

```tsx
// src/tui/mouse/components.tsx
import React, { useRef } from 'react';
import { Box, type DOMElement, type BoxProps } from 'ink';
import { useClick, useScroll } from './hooks.js';

export const Clickable: React.FC<
  { onClick: () => void; z?: number; children: React.ReactNode } & BoxProps
> = ({ onClick, z, children, ...box }) => {
  const ref = useRef<DOMElement>(null);
  useClick(ref, onClick, { z });
  return (
    <Box ref={ref} {...box}>
      {children}
    </Box>
  );
};

export const Scrollable: React.FC<
  { onScroll: (dir: 'up' | 'down') => void; z?: number; children: React.ReactNode } & BoxProps
> = ({ onScroll, z, children, ...box }) => {
  const ref = useRef<DOMElement>(null);
  useScroll(ref, onScroll, { z });
  return (
    <Box ref={ref} {...box}>
      {children}
    </Box>
  );
};
```

- [ ] **Step 6: Run the test + typecheck**

Run: `npx vitest run src/tui/mouse/__tests__/MouseProvider.test.tsx`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS (no type errors in the new files).

- [ ] **Step 7: Commit**

```bash
git add src/tui/mouse
git commit -m "feat(tui): mouse React layer (provider, hooks, Clickable/Scrollable)"
```

---

### Task 6: Live session feed

**Files:**
- Create: `src/tui/sessions/feed.ts`
- Test: `src/tui/sessions/__tests__/feed.test.ts`

**Interfaces:**
- Consumes: `listAllSessions` (`src/dashboard/agent-sessions.js`), `enrichSessions` + `LivenessDeps` (`src/dashboard/session-liveness.js`), `AgentConfig` (`src/utils/config.js`), `AgentSessionWithLiveness` (`src/dashboard/types.js`).
- Produces:
  ```ts
  export interface LoadLiveSessionsOptions {
    projectsDir: string;
    agents: AgentConfig[];
    livenessDeps?: LivenessDeps;
  }
  // Returns every session enriched with liveness, most-recent first.
  export async function loadSessions(opts: LoadLiveSessionsOptions): Promise<AgentSessionWithLiveness[]>;
  // Convenience: only the ones currently live.
  export function liveOnly(sessions: AgentSessionWithLiveness[]): AgentSessionWithLiveness[];
  ```

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
afterEach(() => {
  closeSessionDb();
  rmSync(dir, { recursive: true, force: true });
});

function insertSession(id: string, status: string, pid: number | null) {
  getSessionDb()
    .prepare(
      "INSERT INTO sessions (session_id, agent, started, status, pid) VALUES (?, 'claude', datetime('now'), ?, ?)",
    )
    .run(id, status, pid);
}

describe('session feed', () => {
  it('loads sessions enriched with liveness', async () => {
    insertSession('s1', 'active', 4242);
    const sessions = await loadSessions({
      projectsDir: dir,
      agents,
      livenessDeps: { isPidAlive: () => true, pidStartedAt: () => null },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isLive).toBe(true);
  });

  it('liveOnly filters out non-live sessions', async () => {
    insertSession('dead', 'active', 9999);
    insertSession('done', 'completed', null);
    const sessions = await loadSessions({
      projectsDir: dir,
      agents,
      livenessDeps: { isPidAlive: () => false },
    });
    expect(liveOnly(sessions).map((s) => s.sessionId)).toEqual([]);
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

export interface LoadLiveSessionsOptions {
  projectsDir: string;
  agents: AgentConfig[];
  livenessDeps?: LivenessDeps;
}

export async function loadSessions(
  opts: LoadLiveSessionsOptions,
): Promise<AgentSessionWithLiveness[]> {
  const sessions = await listAllSessions(opts.projectsDir);
  return enrichSessions(sessions, opts.agents, opts.livenessDeps);
}

export function liveOnly(
  sessions: AgentSessionWithLiveness[],
): AgentSessionWithLiveness[] {
  return sessions.filter((s) => s.isLive);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/sessions/__tests__/feed.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/sessions/feed.ts src/tui/sessions/__tests__/feed.test.ts
git commit -m "feat(tui): live session feed reusing listAllSessions + enrichSessions"
```

---

### Task 7: Transcript tail

**Files:**
- Create: `src/tui/sessions/transcript.ts`
- Test: `src/tui/sessions/__tests__/transcript.test.ts`

**Interfaces:**
- Consumes: `chokidar` (already a dependency), `node:fs`.
- Produces:
  ```ts
  export interface TailHandle { stop(): void; }
  export interface TailOptions {
    path: string;
    maxInitialLines?: number;              // default 200
    onLines: (lines: string[]) => void;    // emitted for initial read + each append
    onError?: (err: Error) => void;
  }
  export function tailFile(opts: TailOptions): TailHandle;
  ```
  Emits the last `maxInitialLines` on start, then newly-appended complete lines on each change.

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
  it('emits existing lines on start then appended lines on change', async () => {
    const p = resolve(dir, 'transcript.jsonl');
    writeFileSync(p, 'line1\nline2\n');
    const seen: string[] = [];
    const handle = tailFile({ path: p, onLines: (ls) => seen.push(...ls) });
    await waitFor(() => seen.includes('line2'));

    appendFileSync(p, 'line3\n');
    await waitFor(() => seen.includes('line3'));
    handle.stop();
    expect(seen).toEqual(['line1', 'line2', 'line3']);
  });

  it('calls onError for a missing file without throwing', async () => {
    let err: Error | null = null;
    const handle = tailFile({
      path: resolve(dir, 'nope.jsonl'),
      onLines: () => {},
      onError: (e) => (err = e),
    });
    await waitFor(() => err !== null);
    handle.stop();
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
    const len = size - offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
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
      const combined = carry + text;
      const parts = combined.split('\n');
      carry = parts.pop() ?? ''; // last partial line held for next read
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

  return {
    stop() {
      void watcher.close();
    },
  };
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

### Task 8: tmux detection + launch

**Files:**
- Create: `src/tui/tmux/launch.ts`
- Test: `src/tui/tmux/__tests__/launch.test.ts`

**Interfaces:**
- Consumes: `buildAgentArgv` (`src/tui/launch.js`), `AgentConfig` (`src/utils/config.js`), `node:child_process`.
- Produces:
  ```ts
  export type ExecFn = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  export function tmuxWindowName(projectSlug: string | null, assignmentSlug: string): string;
  export async function isTmuxAvailable(exec?: ExecFn): Promise<boolean>;
  export interface TmuxLaunchInput {
    windowName: string;
    cwd: string;
    command: string;   // from BuiltArgv.argv.command
    args: string[];     // from BuiltArgv.argv.args
    exec?: ExecFn;
  }
  // Builds the `tmux new-session -d` argv (exposed for testing) ...
  export function buildTmuxLaunchArgv(input: TmuxLaunchInput): string[];
  // ... and runs it.
  export async function launchInTmux(input: TmuxLaunchInput): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/tmux/__tests__/launch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildTmuxLaunchArgv, isTmuxAvailable, tmuxWindowName, launchInTmux } from '../launch.js';

describe('tmux launch', () => {
  it('builds a detached new-session argv with name, cwd, and the agent command', () => {
    const argv = buildTmuxLaunchArgv({
      windowName: 'syntaur-proj-assignment',
      cwd: '/repo/.worktrees/feat',
      command: 'claude',
      args: ['/grab-assignment proj assignment', '--agent', 'builder'],
    });
    expect(argv).toEqual([
      'new-session', '-d',
      '-s', 'syntaur-proj-assignment',
      '-c', '/repo/.worktrees/feat',
      'claude', '/grab-assignment proj assignment', '--agent', 'builder',
    ]);
  });

  it('tmuxWindowName is deterministic and sanitized (no dots/colons)', () => {
    expect(tmuxWindowName('proj', 'my.assignment')).toBe('syntaur-proj-my-assignment');
    expect(tmuxWindowName(null, 'stand.alone')).toBe('syntaur-stand-alone');
  });

  it('isTmuxAvailable returns true when `tmux -V` exits 0', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: 'tmux 3.4' }));
    expect(await isTmuxAvailable(exec)).toBe(true);
    expect(exec).toHaveBeenCalledWith('tmux', ['-V']);
  });

  it('isTmuxAvailable returns false when tmux is missing (nonzero/throw)', async () => {
    const exec = vi.fn(async () => { throw new Error('ENOENT'); });
    expect(await isTmuxAvailable(exec)).toBe(false);
  });

  it('launchInTmux runs the built argv through exec', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }));
    await launchInTmux({
      windowName: 'w', cwd: '/x', command: 'claude', args: ['hi'], exec,
    });
    expect(exec).toHaveBeenCalledWith('tmux', [
      'new-session', '-d', '-s', 'w', '-c', '/x', 'claude', 'hi',
    ]);
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

export type ExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string }>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise({ code: 0, stdout: stdout ?? '' });
    });
  });

export function tmuxWindowName(
  projectSlug: string | null,
  assignmentSlug: string,
): string {
  const parts = [projectSlug, assignmentSlug].filter(Boolean) as string[];
  const raw = parts.join('-');
  // tmux session names cannot contain '.' or ':'.
  const sanitized = raw.replace(/[.:]/g, '-').replace(/[^\w-]/g, '-');
  return `syntaur-${sanitized}`;
}

export async function isTmuxAvailable(exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    const { code } = await exec('tmux', ['-V']);
    return code === 0;
  } catch {
    return false;
  }
}

export interface TmuxLaunchInput {
  windowName: string;
  cwd: string;
  command: string;
  args: string[];
  exec?: ExecFn;
}

export function buildTmuxLaunchArgv(input: TmuxLaunchInput): string[] {
  return [
    'new-session',
    '-d',
    '-s',
    input.windowName,
    '-c',
    input.cwd,
    input.command,
    ...input.args,
  ];
}

export async function launchInTmux(input: TmuxLaunchInput): Promise<void> {
  const exec = input.exec ?? defaultExec;
  await exec('tmux', buildTmuxLaunchArgv(input));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/tmux/__tests__/launch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/tmux/launch.ts src/tui/tmux/__tests__/launch.test.ts
git commit -m "feat(tui): tmux detection + detached agent launch argv"
```

---

### Task 9: tmux attach with suspend/resume

**Files:**
- Create: `src/tui/tmux/attach.ts`
- Test: `src/tui/tmux/__tests__/attach.test.ts`

**Interfaces:**
- Consumes: `node:child_process` `spawn`, the `SpawnFn` shape used in `src/launch/execute.ts` (a spawn function returning an object with `.on('exit'|'error', cb)`).
- Produces:
  ```ts
  export function buildTmuxAttachArgv(windowName: string): string[];
  export interface AttachOptions {
    windowName: string;
    onSuspend: () => void; // leave alt-screen + disable mouse tracking
    onResume: () => void;  // re-enter alt-screen + re-enable mouse tracking
    spawnFn?: (cmd: string, args: string[], opts: { stdio: 'inherit' }) => { on(evt: string, cb: (arg?: unknown) => void): void };
  }
  export function attachTmux(opts: AttachOptions): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/tmux/__tests__/attach.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildTmuxAttachArgv, attachTmux } from '../attach.js';

function fakeSpawn(exitCode = 0) {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const child = { on: (evt: string, cb: (arg?: unknown) => void) => { handlers[evt] = cb; } };
  // fire exit on next tick
  queueMicrotask(() => handlers['exit']?.(exitCode));
  return { child, handlers };
}

describe('tmux attach', () => {
  it('builds an attach argv targeting the window', () => {
    expect(buildTmuxAttachArgv('w')).toEqual(['attach-session', '-t', 'w']);
  });

  it('calls onSuspend before spawn and onResume after exit, in order', async () => {
    const order: string[] = [];
    const spawnFn = vi.fn(() => {
      order.push('spawn');
      return fakeSpawn(0).child;
    });
    await attachTmux({
      windowName: 'w',
      onSuspend: () => order.push('suspend'),
      onResume: () => order.push('resume'),
      spawnFn: spawnFn as never,
    });
    expect(order).toEqual(['suspend', 'spawn', 'resume']);
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

export function buildTmuxAttachArgv(windowName: string): string[] {
  return ['attach-session', '-t', windowName];
}

type MinimalChild = { on(evt: string, cb: (arg?: unknown) => void): void };
type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { stdio: 'inherit' },
) => MinimalChild;

export interface AttachOptions {
  windowName: string;
  onSuspend: () => void;
  onResume: () => void;
  spawnFn?: SpawnLike;
}

export function attachTmux(opts: AttachOptions): Promise<void> {
  const spawnImpl: SpawnLike =
    opts.spawnFn ?? ((cmd, args, o) => spawn(cmd, args, o) as unknown as MinimalChild);

  return new Promise<void>((resolvePromise) => {
    opts.onSuspend();
    const child = spawnImpl('tmux', buildTmuxAttachArgv(opts.windowName), {
      stdio: 'inherit',
    });
    const finish = () => {
      opts.onResume();
      resolvePromise();
    };
    child.on('exit', finish);
    child.on('error', finish);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/tui/tmux/__tests__/attach.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/tmux/attach.ts src/tui/tmux/__tests__/attach.test.ts
git commit -m "feat(tui): tmux attach with suspend/resume hooks"
```

---

### Task 10: Cockpit shell + responsive layout

**Files:**
- Create: `src/tui/cockpit/layout.ts`
- Create: `src/tui/cockpit/Cockpit.tsx`
- Test: `src/tui/cockpit/__tests__/layout.test.ts`
- Test: `src/tui/cockpit/__tests__/Cockpit.test.tsx`

**Interfaces:**
- Consumes: `MouseProvider` (Task 5); Ink 7 `useWindowSize` (name confirmed Task 1).
- Produces:
  ```ts
  // layout.ts
  export interface CockpitLayout { columns: 1 | 2; railWidth: number; }
  export function computeLayout(width: number): CockpitLayout; // <80 cols -> single column
  // Cockpit.tsx
  export type FocusTarget = 'rail' | 'detail';
  export const Cockpit: React.FC<{ projectsDir: string; tmuxAvailable: boolean }>;
  ```

- [ ] **Step 1: Write the failing layout test**

```ts
// src/tui/cockpit/__tests__/layout.test.ts
import { describe, it, expect } from 'vitest';
import { computeLayout } from '../layout.js';

describe('computeLayout', () => {
  it('uses two columns at wide widths with a ~32-col rail', () => {
    const l = computeLayout(120);
    expect(l.columns).toBe(2);
    expect(l.railWidth).toBeGreaterThanOrEqual(28);
    expect(l.railWidth).toBeLessThanOrEqual(40);
  });

  it('collapses to a single column below 80 cols', () => {
    expect(computeLayout(70).columns).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement layout**

```ts
// src/tui/cockpit/layout.ts
export interface CockpitLayout {
  columns: 1 | 2;
  railWidth: number;
}

export function computeLayout(width: number): CockpitLayout {
  if (width < 80) return { columns: 1, railWidth: width };
  const railWidth = Math.min(40, Math.max(28, Math.floor(width * 0.28)));
  return { columns: 2, railWidth };
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
import { computeLayout, type FocusTarget } from './layout.js';

export const Cockpit: React.FC<{ projectsDir: string; tmuxAvailable: boolean }> = ({
  projectsDir,
  tmuxAvailable,
}) => {
  const { exit } = useApp();
  const { width, height } = useWindowSize();
  const layout = computeLayout(width);
  const [focus, setFocus] = useState<FocusTarget>('rail');

  useInput((input, key) => {
    if (input === 'q' || key.escape) exit();
    if (key.tab) setFocus((f) => (f === 'rail' ? 'detail' : 'rail'));
  });

  return (
    <MouseProvider>
      <Box flexDirection="column" width={width} height={height}>
        <Box flexGrow={1} flexDirection={layout.columns === 2 ? 'row' : 'column'}>
          <Box
            width={layout.columns === 2 ? layout.railWidth : undefined}
            borderStyle={focus === 'rail' ? 'round' : 'single'}
            flexDirection="column"
          >
            <Text>{`Rail (projectsDir=${projectsDir})`}</Text>
          </Box>
          <Box
            flexGrow={1}
            borderStyle={focus === 'detail' ? 'round' : 'single'}
            flexDirection="column"
          >
            <Text>Detail</Text>
          </Box>
        </Box>
        <Box>
          <Text dimColor>
            {`q quit  ·  tab switch focus  ·  ${tmuxAvailable ? 'tmux ready' : 'no tmux (launch/attach limited)'}`}
          </Text>
        </Box>
      </Box>
    </MouseProvider>
  );
};
```

Also add `export type FocusTarget = 'rail' | 'detail';` to `layout.ts`.

- [ ] **Step 6: Write the shell smoke test**

```tsx
// src/tui/cockpit/__tests__/Cockpit.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Cockpit } from '../Cockpit.js';

describe('Cockpit shell', () => {
  it('renders rail + detail regions and the status bar', () => {
    const { lastFrame } = render(<Cockpit projectsDir="/tmp/p" tmuxAvailable={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Rail');
    expect(frame).toContain('Detail');
    expect(frame).toContain('no tmux');
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
git commit -m "feat(tui): cockpit shell with responsive two-column layout + focus"
```

---

### Task 11: Left rail — live sessions + assignment tree

**Files:**
- Create: `src/tui/cockpit/LeftRail.tsx`
- Modify: `src/tui/cockpit/Cockpit.tsx` (mount `<LeftRail>` in the rail box, lift selection state)
- Test: `src/tui/cockpit/__tests__/LeftRail.test.tsx`

**Interfaces:**
- Consumes: `loadSessions`/`liveOnly` (Task 6), existing `useProjects` (`src/tui/hooks/useProjects.js`), `TreeView` (`src/tui/components/TreeView.js`), `Clickable` (Task 5), `AgentSessionWithLiveness` (`src/dashboard/types.js`).
- Produces:
  ```ts
  export interface LeftRailProps {
    projectsDir: string;
    sessions: AgentSessionWithLiveness[];
    onSelectSession: (s: AgentSessionWithLiveness) => void;
    onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void;
    focused: boolean;
  }
  export const LeftRail: React.FC<LeftRailProps>;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// src/tui/cockpit/__tests__/LeftRail.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { LeftRail } from '../LeftRail.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

const session = {
  sessionId: 's1', agent: 'claude', started: '2026-07-01T00:00:00Z',
  status: 'active', isLive: true, resumeSupported: true, forkSupported: false,
} as AgentSessionWithLiveness;

describe('LeftRail', () => {
  it('renders a Live Sessions header and a live session row', () => {
    const { lastFrame } = render(
      <LeftRail
        projectsDir="/tmp/p"
        sessions={[session]}
        onSelectSession={vi.fn()}
        onSelectAssignment={vi.fn()}
        focused
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Live Sessions');
    expect(frame).toContain('claude');
    expect(frame).toContain('s1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/LeftRail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `LeftRail`**

```tsx
// src/tui/cockpit/LeftRail.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { Clickable } from '../mouse/components.js';
import { statusColor } from '../colors.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';
import type { LeftRailProps } from './types.js';

function SessionRow({
  session,
  onSelect,
}: {
  session: AgentSessionWithLiveness;
  onSelect: () => void;
}) {
  const dot = session.isLive ? '●' : '○';
  return (
    <Clickable onClick={onSelect}>
      <Text>
        <Text color={session.isLive ? 'green' : 'gray'}>{dot} </Text>
        <Text color={statusColor(session.status)}>{session.agent}</Text>
        <Text dimColor> {session.sessionId.slice(0, 8)}</Text>
      </Text>
    </Clickable>
  );
}

export const LeftRail: React.FC<LeftRailProps> = ({ sessions, onSelectSession, focused }) => {
  return (
    <Box flexDirection="column">
      <Text bold underline color={focused ? 'cyan' : undefined}>
        Live Sessions
      </Text>
      {sessions.length === 0 ? (
        <Text dimColor>  (none)</Text>
      ) : (
        sessions.map((s) => (
          <SessionRow key={s.sessionId} session={s} onSelect={() => onSelectSession(s)} />
        ))
      )}
      <Box marginTop={1}>
        <Text bold underline>
          Projects
        </Text>
      </Box>
      {/* Assignment tree wiring: reuse useProjects + TreeView here in Step 4. */}
    </Box>
  );
};
```

Create `src/tui/cockpit/types.ts` with the `LeftRailProps` (and later shared cockpit prop types):

```ts
// src/tui/cockpit/types.ts
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';

export interface LeftRailProps {
  projectsDir: string;
  sessions: AgentSessionWithLiveness[];
  onSelectSession: (s: AgentSessionWithLiveness) => void;
  onSelectAssignment: (projectSlug: string | null, assignmentSlug: string) => void;
  focused: boolean;
}
```

- [ ] **Step 4: Wire the existing tree under the Projects header**

Import and mount the existing tree. Reuse `useProjects` and `TreeView` from `src/tui/`. Because the existing `App.tsx` already composes these with `useTreeState`, extract the tree render into the rail: render `TreeView` with the flattened nodes and forward `onSelectAssignment` to the cockpit. Keep keyboard nav in the cockpit-level `useInput` (Task 10) so the rail stays presentational.

Replace the placeholder comment in `LeftRail.tsx` with:

```tsx
      <ProjectTree projectsDir={projectsDir} onSelectAssignment={onSelectAssignment} focused={focused} />
```

and add a thin `ProjectTree` wrapper (new file `src/tui/cockpit/ProjectTree.tsx`) that composes `useProjects` + `useTreeState` + `TreeView` exactly as `App.tsx` does today, exposing an `onSelectAssignment` callback instead of launching. (Copy the compose logic from `src/tui/App.tsx`; do not re-implement the hooks.)

- [ ] **Step 5: Mount `LeftRail` in `Cockpit.tsx`**

Replace the rail placeholder `<Text>` in `Cockpit.tsx` with `<LeftRail .../>`, add `sessions` state fed by a `useEffect` polling `loadSessions({ projectsDir, agents })` on a ~1.5s interval, and lift `selectedSession` / `selectedAssignment` state for the detail pane (Task 12). Agents come from `readConfig()` → `getAgents(config)`, loaded once at mount.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/tui/cockpit/__tests__/LeftRail.test.tsx`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/cockpit
git commit -m "feat(tui): left rail with live sessions + reused assignment tree"
```

---

### Task 12: Detail pane — assignment detail or transcript

**Files:**
- Create: `src/tui/cockpit/DetailPane.tsx`
- Modify: `src/tui/cockpit/Cockpit.tsx` (mount `<DetailPane>`)
- Test: `src/tui/cockpit/__tests__/DetailPane.test.tsx`

**Interfaces:**
- Consumes: `getAssignmentDetail` (`src/dashboard/api.js`), `tailFile` (Task 7), `Scrollable` (Task 5), `AgentSessionWithLiveness` (`src/dashboard/types.js`).
- Produces:
  ```ts
  export type DetailSelection =
    | { kind: 'assignment'; projectSlug: string | null; assignmentSlug: string }
    | { kind: 'session'; session: AgentSessionWithLiveness }
    | { kind: 'none' };
  export const DetailPane: React.FC<{ projectsDir: string; selection: DetailSelection }>;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// src/tui/cockpit/__tests__/DetailPane.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DetailPane } from '../DetailPane.js';

describe('DetailPane', () => {
  it('shows an empty hint when nothing is selected', () => {
    const { lastFrame } = render(<DetailPane projectsDir="/tmp/p" selection={{ kind: 'none' }} />);
    expect(lastFrame() ?? '').toContain('Select an assignment or session');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/DetailPane.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/tui/cockpit/DetailPane.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Scrollable } from '../mouse/components.js';
import { getAssignmentDetail } from '../../dashboard/api.js';
import { tailFile } from '../sessions/transcript.js';
import { statusColor } from '../colors.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';

export type DetailSelection =
  | { kind: 'assignment'; projectSlug: string | null; assignmentSlug: string }
  | { kind: 'session'; session: AgentSessionWithLiveness }
  | { kind: 'none' };

const MAX_VISIBLE = 200;

function AssignmentDetail({
  projectsDir,
  projectSlug,
  assignmentSlug,
}: {
  projectsDir: string;
  projectSlug: string | null;
  assignmentSlug: string;
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getAssignmentDetail>> | null>(null);
  useEffect(() => {
    let alive = true;
    getAssignmentDetail(projectsDir, projectSlug ?? '', assignmentSlug).then((d) => {
      if (alive) setDetail(d);
    });
    return () => { alive = false; };
  }, [projectsDir, projectSlug, assignmentSlug]);

  if (!detail) return <Text dimColor>Loading…</Text>;
  return (
    <Box flexDirection="column">
      <Text bold>{detail.title}</Text>
      <Text>Status: <Text color={statusColor(detail.status)}>{detail.status}</Text></Text>
      {/* acceptance criteria / plan / recent progress rendered from `detail`
          fields; keep read-only in v1. Confirm exact field names on the
          getAssignmentDetail return type. */}
    </Box>
  );
}

function TranscriptView({ session }: { session: AgentSessionWithLiveness }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    setLines([]);
    if (!session.transcriptPath) {
      setLines(['(no transcript available for this session)']);
      return;
    }
    const handle = tailFile({
      path: session.transcriptPath,
      onLines: (ls) => setLines((prev) => [...prev, ...ls].slice(-MAX_VISIBLE)),
      onError: (e) => setLines([`(transcript error: ${e.message})`]),
    });
    return () => handle.stop();
  }, [session.sessionId, session.transcriptPath]);

  return (
    <Scrollable onScroll={() => {}} flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Scrollable>
  );
}

export const DetailPane: React.FC<{ projectsDir: string; selection: DetailSelection }> = ({
  projectsDir,
  selection,
}) => {
  if (selection.kind === 'none') {
    return <Text dimColor>Select an assignment or session (↑/↓, click)</Text>;
  }
  if (selection.kind === 'assignment') {
    return (
      <AssignmentDetail
        projectsDir={projectsDir}
        projectSlug={selection.projectSlug}
        assignmentSlug={selection.assignmentSlug}
      />
    );
  }
  return <TranscriptView session={selection.session} />;
};
```

> **Note:** Confirm the exact field names on `getAssignmentDetail`'s return type (`title`, `status`, acceptance criteria, plan, progress) from `src/dashboard/types.ts` / `api.ts` and render the read-only fields accordingly. Do not invent field names.

- [ ] **Step 4: Mount in `Cockpit.tsx`**

Replace the detail placeholder `<Text>Detail</Text>` with `<DetailPane projectsDir={projectsDir} selection={selection} />`, where `selection` derives from the lifted `selectedSession`/`selectedAssignment` state from Task 11.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/tui/cockpit/__tests__/DetailPane.test.tsx`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/cockpit
git commit -m "feat(tui): detail pane (assignment detail | live transcript tail)"
```

---

### Task 13: Status bar with clickable actions

**Files:**
- Create: `src/tui/cockpit/ActionBar.tsx`
- Modify: `src/tui/cockpit/Cockpit.tsx` (replace inline status bar)
- Test: `src/tui/cockpit/__tests__/ActionBar.test.tsx`

**Interfaces:**
- Consumes: `Clickable` (Task 5).
- Produces:
  ```ts
  export interface Action { key: string; label: string; onRun: () => void; enabled: boolean; }
  export const ActionBar: React.FC<{ actions: Action[] }>;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// src/tui/cockpit/__tests__/ActionBar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ActionBar } from '../ActionBar.js';

describe('ActionBar', () => {
  it('renders enabled and disabled actions with their key hints', () => {
    const { lastFrame } = render(
      <ActionBar
        actions={[
          { key: 'l', label: 'Launch', onRun: vi.fn(), enabled: true },
          { key: 'a', label: 'Attach', onRun: vi.fn(), enabled: false },
        ]}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Launch');
    expect(frame).toContain('Attach');
    expect(frame).toContain('l');
    expect(frame).toContain('a');
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
import { Clickable } from '../mouse/components.js';

export interface Action {
  key: string;
  label: string;
  onRun: () => void;
  enabled: boolean;
}

export const ActionBar: React.FC<{ actions: Action[] }> = ({ actions }) => {
  return (
    <Box>
      {actions.map((a) => (
        <Box key={a.key} marginRight={2}>
          <Clickable onClick={() => a.enabled && a.onRun()}>
            <Text dimColor={!a.enabled}>
              <Text color={a.enabled ? 'cyan' : 'gray'}>[{a.key}]</Text> {a.label}
            </Text>
          </Clickable>
        </Box>
      ))}
    </Box>
  );
};
```

- [ ] **Step 4: Wire into `Cockpit.tsx`**

Replace the inline status `<Text>` with `<ActionBar actions={actions} />`, where `actions` is built from current selection + `tmuxAvailable`:
- `Launch` — enabled when an assignment is selected.
- `Attach` — enabled when a live session is selected **and** `tmuxAvailable`.
- `Quit` — always enabled (`q`).
Route each action's `key` through the cockpit `useInput` handler too (keyboard parity).

- [ ] **Step 5: Run tests + typecheck + full suite**

Run: `npx vitest run src/tui/cockpit/__tests__/`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/cockpit
git commit -m "feat(tui): clickable action bar with keyboard parity + disabled states"
```

---

### Task 14: `syntaur tui` command + bootstrap

**Files:**
- Create: `src/commands/tui.ts`
- Modify: `src/index.ts` (register the command via `commander`)
- Test: `src/commands/__tests__/tui.test.ts`

**Interfaces:**
- Consumes: `readConfig`/`getAgents` (`src/utils/config.js`), `initSessionDb` (`src/dashboard/session-db.js`), `isTmuxAvailable` (Task 8), `Cockpit` (Task 10), Ink `render` with the alternate-screen option (name confirmed Task 1).
- Produces:
  ```ts
  export interface TuiCommandOptions { cwd?: string; }
  export async function tuiCommand(options?: TuiCommandOptions): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test (bootstrap wiring, no real render)**

```ts
// src/commands/__tests__/tui.test.ts
import { describe, it, expect } from 'vitest';
import { buildTuiRenderProps } from '../tui.js';

describe('tui command bootstrap', () => {
  it('passes projectsDir + tmuxAvailable into the cockpit props', async () => {
    const props = await buildTuiRenderProps({
      config: { defaultProjectDir: '/tmp/projects' } as never,
      isTmuxAvailable: async () => true,
    });
    expect(props.projectsDir).toBe('/tmp/projects');
    expect(props.tmuxAvailable).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/commands/__tests__/tui.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command (split the testable prop-builder from the render side effect)**

```ts
// src/commands/tui.ts
import React from 'react';
import { readConfig, type SyntaurConfig } from '../utils/config.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { isTmuxAvailable as realIsTmuxAvailable } from '../tui/tmux/launch.js';

export interface TuiCommandOptions {
  cwd?: string;
}

export interface CockpitRenderProps {
  projectsDir: string;
  tmuxAvailable: boolean;
}

// Pure, testable: derive render props from config + tmux probe.
export async function buildTuiRenderProps(deps: {
  config: SyntaurConfig;
  isTmuxAvailable: () => Promise<boolean>;
}): Promise<CockpitRenderProps> {
  return {
    projectsDir: deps.config.defaultProjectDir,
    tmuxAvailable: await deps.isTmuxAvailable(),
  };
}

export async function tuiCommand(_options?: TuiCommandOptions): Promise<void> {
  const config = await readConfig();
  initSessionDb();
  const props = await buildTuiRenderProps({
    config,
    isTmuxAvailable: realIsTmuxAvailable,
  });

  // Dynamic import keeps ink/react out of the CLI cold path (matches browse.ts).
  const { render } = await import('ink');
  const { Cockpit } = await import('../tui/cockpit/Cockpit.js');

  // Alternate-screen render option name confirmed in Task 1 Step 2.
  const instance = render(React.createElement(Cockpit, props), {
    // e.g. { fullscreen: true } or { altScreen: true } — use the real key.
    exitOnCtrlC: true,
  } as never);
  await instance.waitUntilExit();
}
```

> **Note:** Set the real alternate-screen option key discovered in Task 1 Step 2 in the `render(...)` options object. Ensure exit always restores the screen (Ink handles this for the alt-screen option; the `MouseProvider` cleanup disables mouse tracking).

- [ ] **Step 4: Register in `src/index.ts`**

Add alongside the other command registrations (mirror how `browse` is registered):

```ts
program
  .command('tui')
  .description('Open the fullscreen agent cockpit (browse, launch, monitor, attach)')
  .action(() => runCommand(() => tuiCommand()));
```
Add the matching `import { tuiCommand } from './commands/tui.js';` at the top with the other command imports.

- [ ] **Step 5: Run the test + build + smoke**

Run: `npx vitest run src/commands/__tests__/tui.test.ts`
Expected: PASS.
Run: `npm run build && node bin/syntaur.js tui`
Expected: fullscreen cockpit opens (rail + detail + action bar); `q` exits and the terminal is restored (no leftover mouse-reporting garbage, scrollback intact).

- [ ] **Step 6: Commit**

```bash
git add src/commands/tui.ts src/commands/__tests__/tui.test.ts src/index.ts
git commit -m "feat(tui): syntaur tui command + alt-screen bootstrap"
```

---

### Task 15: Wire launch + attach actions end-to-end (with graceful degradation)

**Files:**
- Create: `src/tui/cockpit/actions.ts` (action orchestration, testable)
- Modify: `src/tui/cockpit/Cockpit.tsx` (invoke actions from ActionBar/keys)
- Test: `src/tui/cockpit/__tests__/actions.test.ts`

**Interfaces:**
- Consumes: `buildAgentArgv` + `launchAgent` (`src/tui/launch.js`), `launchInTmux`/`tmuxWindowName` (Task 8), `attachTmux` (Task 9), `resolveLaunchPrompt` (`src/launch/launch-prompt.js`) or the existing launch path.
- Produces:
  ```ts
  export interface LaunchDeps {
    tmuxAvailable: boolean;
    launchInTmux: typeof import('../tmux/launch.js').launchInTmux;
    handOffLaunch: (args: { projectSlug: string; assignmentSlug: string }) => Promise<void>;
  }
  // Returns 'tmux' when launched detached, 'handoff' when it fell back.
  export async function runLaunch(
    sel: { projectSlug: string | null; assignmentSlug: string },
    agentAndCwd: { command: string; args: string[]; cwd: string; windowName: string },
    deps: LaunchDeps,
  ): Promise<'tmux' | 'handoff'>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/cockpit/__tests__/actions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runLaunch } from '../actions.js';

describe('runLaunch degradation', () => {
  const argv = { command: 'claude', args: ['hi'], cwd: '/x', windowName: 'w' };

  it('launches into tmux when available', async () => {
    const launchInTmux = vi.fn(async () => {});
    const handOffLaunch = vi.fn(async () => {});
    const mode = await runLaunch({ projectSlug: 'p', assignmentSlug: 'a' }, argv, {
      tmuxAvailable: true, launchInTmux, handOffLaunch,
    });
    expect(mode).toBe('tmux');
    expect(launchInTmux).toHaveBeenCalledOnce();
    expect(handOffLaunch).not.toHaveBeenCalled();
  });

  it('falls back to hand-off when tmux is unavailable', async () => {
    const launchInTmux = vi.fn(async () => {});
    const handOffLaunch = vi.fn(async () => {});
    const mode = await runLaunch({ projectSlug: 'p', assignmentSlug: 'a' }, argv, {
      tmuxAvailable: false, launchInTmux, handOffLaunch,
    });
    expect(mode).toBe('handoff');
    expect(handOffLaunch).toHaveBeenCalledOnce();
    expect(launchInTmux).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/tui/cockpit/__tests__/actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/tui/cockpit/actions.ts
import type { launchInTmux as LaunchInTmux } from '../tmux/launch.js';

export interface LaunchDeps {
  tmuxAvailable: boolean;
  launchInTmux: typeof LaunchInTmux;
  handOffLaunch: (args: { projectSlug: string; assignmentSlug: string }) => Promise<void>;
}

export async function runLaunch(
  sel: { projectSlug: string | null; assignmentSlug: string },
  agentAndCwd: { command: string; args: string[]; cwd: string; windowName: string },
  deps: LaunchDeps,
): Promise<'tmux' | 'handoff'> {
  if (deps.tmuxAvailable) {
    await deps.launchInTmux({
      windowName: agentAndCwd.windowName,
      cwd: agentAndCwd.cwd,
      command: agentAndCwd.command,
      args: agentAndCwd.args,
    });
    return 'tmux';
  }
  await deps.handOffLaunch({
    projectSlug: sel.projectSlug ?? '',
    assignmentSlug: sel.assignmentSlug,
  });
  return 'handoff';
}
```

- [ ] **Step 4: Wire into `Cockpit.tsx`**

- **Launch action:** when triggered, resolve the selected assignment's agent (reuse `getAgents`/agent picker — for v1, default agent or first configured), resolve cwd + prompt via the existing `launch.ts` machinery (`resolveWorkspaceCwd`, `resolveLaunchPrompt`, `buildAgentArgv`), compute `tmuxWindowName(projectSlug, assignmentSlug)`, then call `runLaunch(...)`. On `'handoff'`, unmount Ink (`instance.unmount()` / exit) before the hand-off spawn takes the terminal (mirror `browse` → `launchAgent`). Show a transient toast line with the resulting mode.
- **Attach action:** when a live session is selected and `tmuxAvailable`, call `attachTmux({ windowName, onSuspend, onResume })`, where `onSuspend`/`onResume` disable/re-enable mouse tracking and leave/re-enter the alt-screen. The session's tmux window name is derived the same way it was launched (persist it on launch or reconstruct from the engagement's project/assignment slugs).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/tui/cockpit/__tests__/actions.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Full verification + commit**

```bash
npm run build && npm run typecheck && npm run build --prefix dashboard && npx vitest run
```
Expected: build + typecheck clean, full test suite green.
Manual smoke (with tmux installed): open `syntaur tui`, select an assignment, press `l` → a detached tmux session appears (`tmux ls`), the cockpit stays resident, the session shows in Live Sessions; select it, press `a` → attach into the agent; detach (`Ctrl-b d`) → cockpit resumes cleanly.
Manual smoke (tmux uninstalled / PATH-hidden): `Attach` is greyed; `l` falls back to hand-off (cockpit exits into the agent).

```bash
git add src/tui/cockpit
git commit -m "feat(tui): wire launch (tmux + hand-off fallback) and attach actions"
```

---

## Self-Review

**1. Spec coverage:**
- Fullscreen alt-screen + restore → Task 1 (Ink 7), Task 14 (render option), Task 5 (tracking cleanup). ✅
- Mouse (click/scroll) → Tasks 2–5. ✅
- Browse tree → Task 11 (reuses `useProjects`/`TreeView`). ✅
- Assignment detail → Task 12. ✅
- Live session monitoring + liveness + transcript tail → Tasks 6, 7, 12. ✅
- Launch into tmux + hand-off fallback → Tasks 8, 15. ✅
- Attach/detach → Tasks 9, 15. ✅
- Keyboard parity → Tasks 10, 13, 15 (every action keyed). ✅
- tmux-optional degradation → Tasks 8, 13 (disabled Attach), 15 (fallback). ✅
- No `browse` regression → Task 1 Step 4 smoke. ✅

**2. Placeholder scan:** The two `> Note` blocks (Task 5 `useBoxMetrics` keys, Task 12 assignment-detail field names, Task 14 render option) are **anti-hallucination confirmation gates for external/existing APIs**, not deferred work — each names the exact file to read and what to confirm. All code steps contain complete code. No "TBD"/"add error handling"/"similar to Task N".

**3. Type consistency:** `MouseEvent` (parse) is consumed unchanged by `registry`, `MouseContext`. `HitRegistry.set/remove/dispatch` names are stable across Tasks 4–5. `AgentSessionWithLiveness` used consistently (Tasks 6, 11, 12). `buildTmuxLaunchArgv`/`launchInTmux`/`tmuxWindowName` names stable (Tasks 8, 15). `runLaunch` return `'tmux' | 'handoff'` consistent. `computeLayout`/`CockpitLayout` stable (Task 10 → used in Cockpit). `DetailSelection` defined in Task 12 and referenced by Cockpit state (Tasks 11–13).

**Note for implementer:** Tasks 11–13 each modify `Cockpit.tsx` incrementally; when executed out of order, read the current `Cockpit.tsx` first and integrate rather than overwrite. The lifted state (`selectedSession`, `selectedAssignment`, `sessions`) is introduced in Task 11 Step 5 and consumed by Tasks 12–13.
