import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useMouseRegions } from '../mouse/hooks.js';
import { isMouseSequence } from '../mouse/parse.js';
import { windowTreeRows } from '../components/TreeView.js';
import { resolveRowIndex, buildRailRows, type LeftRailProps, type RailRow } from './railTypes.js';

/**
 * Left rail: the human-labeled Live/Recent session list. The Projects tree
 * moved out to its own sibling pane (see Cockpit.tsx) now that focus is a
 * flat rail|tree|detail cycle. Row content is entirely driven by
 * `buildRailRows` — render and click hit-testing consume the exact same
 * output so they can never diverge (mirrors `actionBarLayout.ts`).
 *
 * Keyboard selection: per design spec §5.2, "keyboard ↑/↓ moves it [the
 * selected row]" — there is no separate cursor/selection distinction the way
 * the Projects tree has one. `cursor` is internal bookkeeping ONLY (which
 * index keyboard movement starts from, and what the scroll window centers
 * on via `windowTreeRows` — the same window the tree renders from); the row
 * highlight is driven purely by the `selectedSessionId` prop, so a stale
 * cursor position left over after an assignment gets selected instead can
 * never show a session as highlighted when it isn't the actual selection.
 */
export const LeftRail: React.FC<LeftRailProps> = ({ contentRect, sessions, selectedSessionId, focused, onSelectSession, liveActivity }) => {
  const [recentExpanded, setRecentExpanded] = useState(false);
  const rows = buildRailRows(sessions, { recentExpanded, liveActivity });
  const viewHeight = Math.max(1, contentRect.height);

  const selectableIndices = useMemo(
    () => rows.reduce<number[]>((acc, r, i) => {
      if (r.kind === 'session' || (r.kind === 'group-header' && r.group === 'recent')) acc.push(i);
      return acc;
    }, []),
    [rows],
  );

  const [cursor, setCursor] = useState(0);

  // Keep the scroll window centered on the externally-selected session (e.g.
  // set by a click elsewhere, or restored on mount) so it's visible without
  // extra scrolling — never fires onSelectSession, just follows it.
  useEffect(() => {
    if (selectedSessionId == null) return;
    const idx = rows.findIndex((r) => r.kind === 'session' && r.session.sessionId === selectedSessionId);
    if (idx >= 0) setCursor(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId]);

  // Rows shrink (RECENT collapses, sessions list changes) — keep the cursor
  // in bounds so `windowTreeRows` never receives an out-of-range index.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const { start, end } = windowTreeRows(rows.length, cursor, viewHeight);
  const visibleRows = rows.slice(start, end);

  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === 'group-header' && row.group === 'recent') {
      setRecentExpanded((v) => !v);
    } else if (row.kind === 'session') {
      onSelectSession(row.session);
    }
  };

  const moveCursor = (delta: number) => {
    if (selectableIndices.length === 0) return;
    const curPos = selectableIndices.indexOf(cursor);
    // Starting from a non-selectable row (e.g. the LIVE header, or nothing
    // selected yet): a downward move enters at the top, an upward move
    // enters at the bottom — regardless of the move's magnitude (a PgDn from
    // an unselected state just enters at the top, not "top + a page").
    const nextPos = curPos === -1
      ? (delta > 0 ? 0 : selectableIndices.length - 1)
      : Math.min(Math.max(curPos + delta, 0), selectableIndices.length - 1);
    const nextIndex = selectableIndices[nextPos];
    setCursor(nextIndex);
    // Moving onto a session row selects it immediately (spec §5.2); moving
    // onto the RECENT header just parks the cursor there — Enter toggles it.
    const row = rows[nextIndex];
    if (row?.kind === 'session') onSelectSession(row.session);
  };

  useMouseRegions([
    {
      id: 'rail-sessions',
      rect: contentRect,
      onScroll: (e) => moveCursor(e.action === 'scroll-up' ? -1 : 1),
      onClick: (e) => {
        // Click math is viewport-aware: render and hit-test the SAME slice,
        // and the click selects INTO that slice — never `rows[idx]`, never
        // `sessions[idx]`.
        const idx = resolveRowIndex(contentRect, e.y, 0);
        if (idx === null || idx >= visibleRows.length) return;
        const absoluteIndex = start + idx;
        setCursor(absoluteIndex);
        activate(absoluteIndex);
      },
    },
  ]);

  useInput(
    (input, key) => {
      if (isMouseSequence(input)) return;
      if (key.upArrow || input === 'k') moveCursor(-1);
      else if (key.downArrow || input === 'j') moveCursor(1);
      else if (key.pageUp) moveCursor(-viewHeight);
      else if (key.pageDown) moveCursor(viewHeight);
      else if (key.return) activate(cursor);
    },
    { isActive: focused },
  );

  return (
    <Box flexDirection="column">
      {visibleRows.map((row, i) => (
        <Text key={i} wrap="truncate" inverse={row.kind === 'session' && row.session.sessionId === selectedSessionId}>
          {renderRow(row)}
        </Text>
      ))}
    </Box>
  );
};

function renderRow(row: RailRow): React.ReactNode {
  if (row.kind === 'group-header') {
    const chevron = row.group === 'recent' ? (row.expanded ? '▾' : '▸') : '▾';
    return <Text bold>{chevron} {row.label}</Text>;
  }
  if (row.kind === 'more') {
    return <Text dimColor>  …and {row.count} more</Text>;
  }
  return (
    <>
      <Text color={row.glyphColor}>{row.glyph} </Text>
      {row.label}
      {row.activityText ? <Text color={row.isWaiting ? 'yellow' : undefined}> {row.activityText}</Text> : null}
      {'  '}
      <Text dimColor>{row.age}</Text>
    </>
  );
}
