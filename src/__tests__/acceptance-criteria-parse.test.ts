import { describe, it, expect } from 'vitest';
import { parseAcceptanceCriteria } from '../utils/acceptance-criteria-parse.js';

describe('parseAcceptanceCriteria', () => {
  it('parses a standard checklist', () => {
    const content = [
      '# Title',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] First',
      '- [x] Second done',
      '- [ ] Third',
      '',
    ].join('\n');

    const result = parseAcceptanceCriteria(content);
    expect(result).toEqual([
      { index: 0, text: 'First', checked: false },
      { index: 1, text: 'Second done', checked: true },
      { index: 2, text: 'Third', checked: false },
    ]);
  });

  it('returns [] when the section is missing', () => {
    const content = '# Title\n\nSome other content.\n';
    expect(parseAcceptanceCriteria(content)).toEqual([]);
  });

  it('stops at the next ## heading', () => {
    const content = [
      '## Acceptance Criteria',
      '- [ ] One',
      '',
      '## Out of scope',
      '- [ ] Should not appear',
      '',
    ].join('\n');

    const result = parseAcceptanceCriteria(content);
    expect(result).toEqual([{ index: 0, text: 'One', checked: false }]);
  });

  it('stops at the next # heading', () => {
    const content = [
      '## Acceptance Criteria',
      '- [ ] One',
      '',
      '# New section',
      '- [ ] Should not appear',
      '',
    ].join('\n');

    const result = parseAcceptanceCriteria(content);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('One');
  });

  it('handles `*` markers and leading whitespace', () => {
    const content = [
      '## Acceptance Criteria',
      '  * [ ] Indented',
      '*  [X] Star with capital X',
      '',
    ].join('\n');

    const result = parseAcceptanceCriteria(content);
    expect(result).toEqual([
      { index: 0, text: 'Indented', checked: false },
      { index: 1, text: 'Star with capital X', checked: true },
    ]);
  });

  it('ignores non-checkbox bullets between criteria', () => {
    const content = [
      '## Acceptance Criteria',
      '- [ ] Real one',
      '- A normal bullet',
      '- [x] Another real one',
      '',
    ].join('\n');

    const result = parseAcceptanceCriteria(content);
    expect(result).toEqual([
      { index: 0, text: 'Real one', checked: false },
      { index: 1, text: 'Another real one', checked: true },
    ]);
  });

  it('strips frontmatter so a `## …` inside it does not anchor the section', () => {
    const content = [
      '---',
      'title: weird',
      'note: |',
      '  ## Acceptance Criteria',
      '  - [ ] not a real criterion',
      '---',
      '',
      'Body text.',
      '',
    ].join('\n');

    expect(parseAcceptanceCriteria(content)).toEqual([]);
  });
});
