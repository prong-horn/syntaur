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
