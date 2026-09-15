import { describe, it, expect } from 'vitest';
import {
  parseLogEntries,
  openQuestions,
  latestEntry,
  formatLogEntry,
} from '../ticket-templates/log-reader.js';

describe('parseLogEntries hardening', () => {
  it('treats ## Summary and ## What shipped as body continuation', () => {
    const content = `---
purpose: journal
updated: "2026-09-01T08:00:00Z"
---

## 2026-09-01T10:00:00Z · progress · human

Shipped the feature.

## Summary

Bullet one

## What shipped

The API

## 2026-09-01T09:00:00Z · note · legacy

Older note
`;
    const entries = parseLogEntries(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].body).toContain('## Summary');
    expect(entries[0].body).toContain('## What shipped');
    expect(entries[1].author).toBe('legacy');
  });

  it('parses ISO timestamp with em-dash title as progress entry', () => {
    const content = `---
updated: "2026-05-26T13:55:00Z"
---

## 2026-05-26T13:55:00Z — Implemented, merged

Body text here.
`;
    const entries = parseLogEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].timestamp).toBe('2026-05-26T13:55:00Z');
    expect(entries[0].type).toBe('progress');
    expect(entries[0].author).toBeNull();
    expect(entries[0].firstLine).toBe('Implemented, merged');
    expect(entries[0].body).toContain('Body text here.');
  });

  it('parses bare date with em-dash title at midnight Z', () => {
    const content = `---
updated: "2026-05-25T00:00:00Z"
---

## 2026-05-25 — Implementation complete

Done for the day.
`;
    const entries = parseLogEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].timestamp).toBe('2026-05-25T00:00:00Z');
    expect(entries[0].firstLine).toBe('Implementation complete');
  });

  it('keeps preamble before the first entry as a synthetic progress entry', () => {
    const content = `---
updated: "2026-06-01T12:00:00Z"
---

# Progress

Orphan intro line.

## 2026-06-01T11:00:00Z · note · human

Real entry
`;
    const entries = parseLogEntries(content);
    expect(entries).toHaveLength(2);
    const synthetic = entries.find((e) => e.timestamp === '2026-06-01T12:00:00Z');
    expect(synthetic?.type).toBe('progress');
    expect(synthetic?.body).toContain('Orphan intro line');
  });

  it('parses any \\S+ author token in typed headings', () => {
    const content = `---
purpose: x
---

## 2026-09-01T10:00:00Z · decision · brennen

Chose A
`;
    const entries = parseLogEntries(content);
    expect(entries[0].author).toBe('brennen');
  });

  it('parses verdict, answers and attachments key lines', () => {
    const content = `---
purpose: x
---

## 2026-09-01T10:00:00Z · review · human
verdict: approve · open: high=0 medium=0

Clean.

## 2026-09-01T09:00:00Z · answer · human
answers: 2026-09-01T08:00:00Z

Yes.

## 2026-09-01T08:00:00Z · progress · human
attachments: abc__file.png, def__other.jpg

With files.
`;
    const entries = parseLogEntries(content);
    const review = entries.find((e) => e.type === 'review')!;
    expect(review.keys.verdict).toBe('approve · open: high=0 medium=0');
    const answer = entries.find((e) => e.type === 'answer')!;
    expect(answer.keys.answers).toBe('2026-09-01T08:00:00Z');
    const progress = entries.find((e) => e.type === 'progress' && e.keys.attachments)!;
    expect(progress.keys.attachments).toContain('abc__file.png');
  });
});

describe('openQuestions', () => {
  it('returns unanswered questions only', () => {
    const entries = parseLogEntries(`---
purpose: x
---

## 2026-09-01T10:00:00Z · question · human

Open?

## 2026-09-01T09:00:00Z · question · human

Closed?

## 2026-09-01T08:00:00Z · answer · human
answers: 2026-09-01T09:00:00Z

Done
`);
    const open = openQuestions(entries);
    expect(open).toHaveLength(1);
    expect(open[0].timestamp).toBe('2026-09-01T10:00:00Z');
  });
});

describe('latestEntry', () => {
  it('returns the newest entry of the given type', () => {
    const entries = parseLogEntries(`---
purpose: x
---

## 2026-09-02T10:00:00Z · handoff · human

New baton

## 2026-09-01T10:00:00Z · handoff · human

Old baton
`);
    const h = latestEntry(entries, 'handoff');
    expect(h?.firstLine).toBe('New baton');
  });
});

describe('formatLogEntry round-trip', () => {
  it('demotes body sub-headings, inserts a blank line before body, and re-parses', () => {
    const block = formatLogEntry({
      timestamp: '2026-09-01T12:00:00Z',
      type: 'decision',
      author: 'human',
      body: '## Context\n\nDetails',
    });
    expect(block).toContain('## 2026-09-01T12:00:00Z · decision · human\n\n### Context');
    const entries = parseLogEntries(block);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain('### Context');
    expect(entries[0].body).not.toMatch(/^## Context/m);
  });

  it('round-trips key lines', () => {
    const block = formatLogEntry({
      timestamp: '2026-09-01T12:00:00Z',
      type: 'review',
      author: 'human',
      keys: { verdict: 'approve · open: high=0 medium=0' },
      body: 'LGTM',
    });
    const entries = parseLogEntries(block);
    expect(entries[0].keys.verdict).toBe('approve · open: high=0 medium=0');
    expect(entries[0].body).toBe('LGTM');
  });
});
