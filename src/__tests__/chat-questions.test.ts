import { describe, it, expect } from 'vitest';
import {
  formatChatQuestionMarker,
  parseChatQuestionMarker,
  detectOpenQuestion,
  questionBodyForCard,
} from '../chat/questions.js';

describe('formatChatQuestionMarker / parseChatQuestionMarker', () => {
  it('round-trips a reply marker with turn', () => {
    const marker = formatChatQuestionMarker({ kind: 'reply', itemId: 'item-42', turnId: 'turn-9' });
    const body = `Which name should I use?\n\n${marker}`;
    const { ref, text } = parseChatQuestionMarker(body);
    expect(ref).toEqual({ kind: 'reply', itemId: 'item-42', turnId: 'turn-9' });
    expect(text).toBe('Which name should I use?');
  });

  it('round-trips without turn', () => {
    const marker = formatChatQuestionMarker({ kind: 'permission', itemId: 'perm-1' });
    const { ref, text } = parseChatQuestionMarker(`Waiting\n\n${marker}`);
    expect(ref).toEqual({ kind: 'permission', itemId: 'perm-1' });
    expect(text).toBe('Waiting');
  });

  it('parses markers with reordered attributes', () => {
    const body = 'Prompt text\n\n<!-- syntaur-chat item="q-7" kind="ask" -->';
    const { ref, text } = parseChatQuestionMarker(body);
    expect(ref).toEqual({ kind: 'ask', itemId: 'q-7' });
    expect(text).toBe('Prompt text');
  });

  it('returns null ref when no marker is present', () => {
    const { ref, text } = parseChatQuestionMarker('Plain question?');
    expect(ref).toBeNull();
    expect(text).toBe('Plain question?');
  });
});

describe('detectOpenQuestion positives', () => {
  const positives = [
    'Say if you want a commit or an implementation review.',
    'Which name should I use: alpha or beta?',
    'Let me know which approach you prefer.',
    'Should I proceed with the migration?',
    'Do you want me to run the tests first?',
    'Would you like a PR or a direct commit?',
    'Want me to refactor this module?',
    'Your call on the naming.',
    'Please confirm before I delete the file.',
    'I can use either pattern — which option do you prefer?',
    'Shall I update the docs as well?',
    'Tell me if I should squash the commits.',
    'Is this the right file to edit?',
    'First I read the plan.\n\nShould we ship this today?',
    'The build passed.\n\nAny objections to merging?',
    'Ready when you are — prefer a review first?',
    'Should we use Redis?\n\nThe migration is complete.',
  ];

  for (const text of positives) {
    it(`detects: ${text.slice(0, 50)}…`, () => {
      expect(detectOpenQuestion(text)).toBeTruthy();
    });
  }
});

describe('detectOpenQuestion negatives', () => {
  const negatives = [
    'Done. Let me know if you need anything else.',
    'Happy to help with anything else.',
    'I created the file and ran the tests.',
    '',
    '   \n\n  ',
    'Here is the summary.\n\n```\nconst x = 1;\n```',
    'Feel free to ping me if you have any other questions.',
    'All tasks are finished.',
    'The endpoint now returns 200.',
    'I updated the types and fixed the lint errors.',
    'No changes were required.',
    'Running the suite now.',
    '```ts\nexport {}\n```',
    'If you need anything, just ask.',
    'Let me know if you have any questions about the design doc.',
  ];

  for (const text of negatives) {
    it(`rejects: ${text.slice(0, 50) || '(empty)'}`, () => {
      expect(detectOpenQuestion(text)).toBeNull();
    });
  }
});

describe('detectOpenQuestion clipping', () => {
  it('clips at 600 characters with an ellipsis', () => {
    const long = 'Should I proceed? ' + 'x'.repeat(700);
    const result = detectOpenQuestion(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(602);
    expect(result!.endsWith('…')).toBe(true);
  });
});

describe('detectOpenQuestion two-paragraph rule (Decision 2 amended)', () => {
  it('files the question paragraph when followed by a short plain statement', () => {
    const text =
      'Which name should I use for the new file: **alpha** or **beta**?\n\nI have not created anything yet and will wait for your pick before touching the repo.';
    expect(detectOpenQuestion(text)).toContain('Which name should I use');
  });

  it('returns null for boilerplate in the last paragraph', () => {
    expect(detectOpenQuestion('Done.\n\nLet me know if you need anything else.')).toBeNull();
  });

  it('returns null when a long final statement follows a question', () => {
    const text = `Should we ship?\n\n${'x'.repeat(241)}`;
    expect(detectOpenQuestion(text)).toBeNull();
  });

  it('returns null when the question is three paragraphs up', () => {
    const text = 'Should we use alpha?\n\nMiddle paragraph.\n\nPlain closing statement.';
    expect(detectOpenQuestion(text)).toBeNull();
  });
});

describe('questionBodyForCard', () => {
  it('formats permission cards', () => {
    expect(questionBodyForCard('permission', 'npm test')).toBe(
      'Waiting for your permission to run **npm test** in the chat.',
    );
  });

  it('passes through ask prompts', () => {
    expect(questionBodyForCard('ask', 'Which colour?')).toBe('Which colour?');
  });
});
