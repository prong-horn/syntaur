import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useMouseRegions } from '../mouse/hooks.js';
import { isMouseSequence } from '../mouse/parse.js';
import { useViewport } from '../mouse/scroll.js';
import { resolveRowIndex, buildRailRows, type LeftRailProps, type RailRow } from './railTypes.js';

/**
 * Left rail: the human-labeled Live/Recent session list. The Projects tree
 * moved out to its own sibling pane (see Cockpit.tsx) now that focus is a
 * flat rail|tree|detail cycle. Row content is entirely driven by
 * `buildRailRows` — render and click hit-testing consume the exact same
 * output so they can never diverge (mirrors `actionBarLayout.ts`).
 */
export const LeftRail: React.FC<LeftRailProps> = ({ contentRect, sessions, selectedSessionId, focused, onSelectSession }) => {
  const [recentExpanded, setRecentExpanded] = useState(false);
  const rows = buildRailRows(sessions, { recentExpanded });
  const viewHeight = Math.max(1, contentRect.height);
  const viewport = useViewport(rows.length, viewHeight, { followTail: false });
  // Click math is viewport-aware: render and hit-test the SAME slice, and the
  // click selects INTO that slice — never `rows[idx]`, never `sessions[idx]`.
  const visibleRows = rows.slice(viewport.offset, viewport.offset + viewHeight);

  useMouseRegions([
    {
      id: 'rail-sessions',
      rect: contentRect,
      onScroll: viewport.onWheel,
      onClick: (e) => {
        const idx = resolveRowIndex(contentRect, e.y, 0);
        if (idx === null || idx >= visibleRows.length) return;
        const row = visibleRows[idx];
        if (row.kind === 'group-header' && row.group === 'recent') {
          setRecentExpanded((v) => !v);
        } else if (row.kind === 'session') {
          onSelectSession(row.session);
        }
        // 'more' rows and the LIVE header are non-selectable — no-op.
      },
    },
  ]);

  useInput(
    (input, key) => {
      if (isMouseSequence(input)) return;
      if (key.upArrow || input === 'k') viewport.scrollBy(-1);
      else if (key.downArrow || input === 'j') viewport.scrollBy(1);
      else if (key.pageUp) viewport.scrollBy(-viewHeight);
      else if (key.pageDown) viewport.scrollBy(viewHeight);
      else if (key.return) {
        // Enter mirrors a click on the row under the (list-relative) cursor —
        // there is no separate rail cursor, so Enter toggles RECENT when it's
        // the only collapsed group and otherwise does nothing (mouse/Enter
        // parity for the one stateful toggle this pane owns).
        if (visibleRows.length === 1 && visibleRows[0].kind === 'group-header' && visibleRows[0].group === 'recent') {
          setRecentExpanded((v) => !v);
        }
      }
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
