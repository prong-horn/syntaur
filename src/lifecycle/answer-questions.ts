import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import {
  openQuestions,
  parseLogEntries,
  type LogEntry,
} from '../ticket-templates/log-reader.js';
import { appendTypedLogEntry, resolveLogRole } from './log-append.js';

/** Append `answer` entries for open questions matching `predicate`. */
export async function answerChatQuestions(
  ticketDir: string,
  ticketId: string,
  predicate: (e: LogEntry) => boolean,
  body: string,
  author = 'human',
): Promise<string[]> {
  try {
    const { logPath } = await resolveLogRole(ticketDir);
    const path = resolve(ticketDir, logPath);
    if (!(await fileExists(path))) return [];
    const entries = parseLogEntries(await readFile(path, 'utf-8'));
    const targets = openQuestions(entries).filter(predicate);
    const answered: string[] = [];
    const trimmedBody = body.trim() || '(resolved)';
    for (const q of targets) {
      await appendTypedLogEntry({
        ticketDir,
        ticketId,
        type: 'answer',
        body: trimmedBody,
        author,
        keys: { answers: q.timestamp },
      });
      answered.push(q.timestamp);
    }
    return answered;
  } catch {
    return [];
  }
}
