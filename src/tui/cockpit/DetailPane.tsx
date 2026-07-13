import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getAssignmentDetail, getAssignmentDetailById } from '../../dashboard/api.js';
import { tailFile } from '../sessions/transcript.js';
import { isMouseSequence } from '../mouse/parse.js';
import { useMouseRegions } from '../mouse/hooks.js';
import { useViewport } from '../mouse/scroll.js';
import { createTranscriptRenderer, type DisplayRow, type DisplayRowStyle, type TranscriptRenderer } from '../transcript-render/index.js';
import { statusColors } from '../colors.js';
import { parseAcceptanceCriteria } from './acParse.js';
import type { Rect } from '../mouse/registry.js';
import type { AssignmentDetail, AgentSessionWithLiveness } from '../../dashboard/types.js';

export type DetailSelection =
  | { kind: 'assignment'; projectSlug: string | null; assignmentSlug: string }
  | { kind: 'session'; session: AgentSessionWithLiveness }
  | { kind: 'none' };

/** Rows kept in memory/display for the transcript pane — older rows are dropped as new ones arrive. */
const MAX_TRANSCRIPT_ROWS = 500;

function styleColor(style: DisplayRowStyle): string | undefined {
  switch (style) {
    case 'user':
      return 'cyan';
    case 'tool':
      return 'magenta';
    case 'error':
      return 'red';
    case 'assistant':
    case 'meta':
      return undefined;
  }
}

interface SlicedWithIndicators {
  visible: DisplayRow[];
  moreAbove: number;
  moreBelow: number;
}

/**
 * Slices `rows` for display, reserving a row at the top/bottom for a
 * `▲ N more`/`▼ N more` indicator whenever there's hidden content on that
 * side — so the indicator can never push the pane past `viewHeight` rows
 * total (AC: never overflow the pane). Whether each indicator is needed is
 * decided against the FULL `viewHeight` window (not a window already
 * shrunk by the other indicator) so a pane pinned to the bottom (follow-tail)
 * still ends exactly on the newest row instead of one hidden behind a
 * spuriously-reserved bottom indicator.
 */
export function sliceWithIndicators(rows: DisplayRow[], offset: number, viewHeight: number): SlicedWithIndicators {
  const maxOffset = Math.max(0, rows.length - viewHeight);
  const showTop = offset > 0;
  const showBottom = offset < maxOffset;
  let height = viewHeight;
  if (showTop) height -= 1;
  if (showBottom) height -= 1;
  height = Math.max(0, height);
  // At the bottom, anchor the slice to the true END (using the possibly-
  // smaller `height`) so the newest row is always what's shown; otherwise
  // anchor to `offset` as normal.
  const start = showBottom ? offset : Math.max(0, rows.length - height);
  const visible = rows.slice(start, start + height);
  return {
    visible,
    moreAbove: showTop ? start : 0,
    moreBelow: showBottom ? Math.max(0, rows.length - start - visible.length) : 0,
  };
}

interface PaneProps {
  contentRect: Rect;
  focused: boolean;
}

function AssignmentView({
  projectsDir, assignmentsDir, projectSlug, assignmentSlug, contentRect, focused,
}: { projectsDir: string; assignmentsDir: string; projectSlug: string | null; assignmentSlug: string } & PaneProps) {
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    const p = projectSlug
      ? getAssignmentDetail(projectsDir, projectSlug, assignmentSlug)
      : getAssignmentDetailById(projectsDir, assignmentsDir, assignmentSlug);
    p.then((d) => { if (alive) setDetail(d); }).catch(() => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [projectsDir, assignmentsDir, projectSlug, assignmentSlug]);

  const lines: DisplayRow[] = [];
  if (detail) {
    lines.push({ text: detail.title, style: 'assistant' });
    lines.push({ text: `Status: ${detail.status}`, style: 'meta' });
    const acs = parseAcceptanceCriteria(detail.body);
    if (acs.length > 0) {
      lines.push({ text: '', style: 'meta' });
      lines.push({ text: 'Acceptance Criteria', style: 'assistant' });
      for (const c of acs) lines.push({ text: `${c.checked ? '☑' : '☐'} ${c.text}`, style: 'meta' });
    }
    if (detail.plan) {
      lines.push({ text: '', style: 'meta' });
      lines.push({ text: `plan: ${detail.plan.status} (updated ${detail.plan.updated})`, style: 'meta' });
    }
  }

  const viewHeight = Math.max(1, contentRect.height);
  const viewport = useViewport(lines.length, viewHeight, { followTail: false });
  const { visible, moreAbove, moreBelow } = sliceWithIndicators(lines, viewport.offset, viewHeight);

  useMouseRegions([{ id: 'detail-assignment', rect: contentRect, onScroll: viewport.onWheel }]);
  useInput(
    (input, key) => {
      if (isMouseSequence(input)) return;
      if (key.upArrow || input === 'k') viewport.scrollBy(-1);
      else if (key.downArrow || input === 'j') viewport.scrollBy(1);
      else if (key.pageUp) viewport.scrollBy(-viewHeight);
      else if (key.pageDown) viewport.scrollBy(viewHeight);
    },
    { isActive: focused },
  );

  if (!detail) return <Text dimColor>Loading…</Text>;

  return (
    <Box flexDirection="column">
      {moreAbove > 0 && <Text dimColor>▲ {moreAbove} more</Text>}
      {visible.map((line, i) => {
        if (line.text === '') return <Text key={i}> </Text>;
        // The title is always `lines[0]`; `i` is an index into the VISIBLE
        // slice, not the content, so it must only match the title when
        // nothing is scrolled above it (`moreAbove === 0` ⟺ the slice starts
        // at absolute index 0 — see `sliceWithIndicators`). Matching on `i
        // === 0` alone bolds whatever line is first on screen after
        // scrolling, not the actual title.
        if (moreAbove === 0 && i === 0) return <Text key={i} bold>{line.text}</Text>;
        if (line.text.startsWith('Status: ')) {
          return <Text key={i}>Status: <Text color={statusColors[detail.status] ?? 'white'}>{detail.status}</Text></Text>;
        }
        if (line.text === 'Acceptance Criteria') return <Text key={i} bold underline>{line.text}</Text>;
        return <Text key={i} wrap="truncate" dimColor={line.style === 'meta'}>{line.text}</Text>;
      })}
      {moreBelow > 0 && <Text dimColor>▼ {moreBelow} more</Text>}
    </Box>
  );
}

function TranscriptView({ session, contentRect, focused }: { session: AgentSessionWithLiveness } & PaneProps) {
  const [rows, setRows] = useState<DisplayRow[]>([]);
  const rendererRef = useRef<TranscriptRenderer | null>(null);
  const widthRef = useRef(contentRect.width);

  useEffect(() => {
    setRows([]);
    const renderer = createTranscriptRenderer({ width: contentRect.width });
    rendererRef.current = renderer;
    widthRef.current = contentRect.width;
    if (!session.transcriptPath) {
      setRows([{ text: '(no transcript available)', style: 'meta' }]);
      return;
    }
    const h = tailFile({
      path: session.transcriptPath,
      onLines: (ls) => {
        const delta = renderer.push(ls);
        if (delta.length) setRows((prev) => [...prev, ...delta].slice(-MAX_TRANSCRIPT_ROWS));
      },
      onError: (e) => setRows([{ text: `(transcript error: ${e.message})`, style: 'error' }]),
    });
    return () => h.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, session.transcriptPath]);

  // Width change: re-derive ALL rows from the renderer's retained parsed
  // events rather than re-reading the file (see transcript-render's resize contract).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || widthRef.current === contentRect.width) return;
    widthRef.current = contentRect.width;
    setRows(renderer.resize(contentRect.width).slice(-MAX_TRANSCRIPT_ROWS));
  }, [contentRect.width]);

  const viewHeight = Math.max(1, contentRect.height);
  const viewport = useViewport(rows.length, viewHeight);
  const { visible, moreAbove, moreBelow } = sliceWithIndicators(rows, viewport.offset, viewHeight);

  useMouseRegions([{ id: 'detail-transcript', rect: contentRect, onScroll: viewport.onWheel }]);
  useInput(
    (input, key) => {
      if (isMouseSequence(input)) return;
      if (key.upArrow || input === 'k') viewport.scrollBy(-1);
      else if (key.downArrow || input === 'j') viewport.scrollBy(1);
      else if (key.pageUp) viewport.scrollBy(-viewHeight);
      else if (key.pageDown) viewport.scrollBy(viewHeight);
      else if (key.end) viewport.toBottom();
    },
    { isActive: focused },
  );

  return (
    <Box flexDirection="column">
      {moreAbove > 0 && <Text dimColor>▲ {moreAbove} more</Text>}
      {visible.map((row, i) => (
        <Text key={i} wrap="truncate" color={styleColor(row.style)} dimColor={row.style === 'meta'}>
          {row.text}
        </Text>
      ))}
      {moreBelow > 0 && <Text dimColor>▼ {moreBelow} more</Text>}
    </Box>
  );
}

export const DetailPane: React.FC<{
  projectsDir: string;
  assignmentsDir: string;
  selection: DetailSelection;
  contentRect: Rect;
  focused: boolean;
}> = ({ projectsDir, assignmentsDir, selection, contentRect, focused }) => {
  if (selection.kind === 'none') return <Text dimColor>Select an assignment or session (↑/↓, click)</Text>;
  if (selection.kind === 'assignment')
    return (
      <AssignmentView
        // Keyed by assignment identity so a fresh selection remounts the view
        // instead of reusing the previous assignment's `useViewport` scroll
        // offset — otherwise switching assignments while scrolled would open
        // the new one's (unrelated) content at the old scroll position.
        key={`${selection.projectSlug ?? ''}/${selection.assignmentSlug}`}
        projectsDir={projectsDir}
        assignmentsDir={assignmentsDir}
        projectSlug={selection.projectSlug}
        assignmentSlug={selection.assignmentSlug}
        contentRect={contentRect}
        focused={focused}
      />
    );
  return (
    <TranscriptView
      // Keyed by sessionId so a fresh selection remounts the view instead of
      // reusing the previous session's `useViewport` state — without this, a
      // prior session scrolled up (followTail=false) leaves a newly-selected
      // session opening pinned to the top instead of following its tail.
      key={selection.session.sessionId}
      session={selection.session}
      contentRect={contentRect}
      focused={focused}
    />
  );
};
