import type { ChatRecordKind, FiledChatRecord } from './chat-types';

export const RECORD_MENU: Array<{ kind: ChatRecordKind; label: string }> = [
  { kind: 'decision', label: 'File as decision…' },
  { kind: 'progress', label: 'File as progress entry…' },
  { kind: 'comment', label: 'File as comment…' },
];

const LEADING_MARKERS = /^(\s*[-*+]\s+|\s*>\s+|\s*#{1,6}\s+|\s*[*_]+|[*_]+)/;

export function defaultRecordTitle(text: string): string {
  const lines = text.split('\n');
  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    while (LEADING_MARKERS.test(trimmed)) {
      trimmed = trimmed.replace(LEADING_MARKERS, '').trim();
    }
    trimmed = trimmed.replace(/^[*_]+|[*_]+$/g, '').trim();
    if (!trimmed) continue;
    if (trimmed.length <= 80) return trimmed;
    const slice = trimmed.slice(0, 80);
    const lastSpace = slice.lastIndexOf(' ');
    const cut = lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
    return `${cut.trim()}…`;
  }
  return 'Untitled decision';
}

export function recordFiledCopy(record: FiledChatRecord): string {
  switch (record.kind) {
    case 'decision':
      return `Filed as ${record.ref} — see the Decisions tab`;
    case 'progress':
      return 'Filed as a progress entry — see the Progress tab';
    case 'comment':
      return `Filed as ${record.label} — see the Comments tab`;
  }
}
