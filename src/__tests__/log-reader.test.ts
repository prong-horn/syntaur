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

  it('parses any \\S+ author token', () => {
    const content = `---
purpose: x
---

## 2026-09-01T10:00:00Z · decision · brennen

Chose A
`;
    const entries = parseLogEntries(content);
    expect(entries[0].author).toBe('brennen');
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
  it('demotes body sub-headings and re-parses', () => {
    const block = formatLogEntry({
      timestamp: '2026-09-01T12:00:00Z',
      type: 'decision',
      author: 'human',
      body: '## Context\n\nDetails',
    });
    const entries = parseLogEntries(block);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain('### Context');
    expect(entries[0].body).not.toMatch(/^## Context/m);
  });
});
