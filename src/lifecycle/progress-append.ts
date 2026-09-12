import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { formatProgressEntry, renderProgress } from '../templates/index.js';

/**
 * Insert a new entry immediately after the `# Progress` H1 (reverse-chronological),
 * replacing the `No progress yet.` placeholder if present. Frontmatter `entryCount`
 * is incremented and `updated` bumped; `ticket` and `generated` are preserved
 * verbatim (we edit the raw frontmatter rather than round-tripping through a parser
 * that would drop `generated`).
 */
export function appendProgressEntry(content: string, entry: string, now: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('progress.md has no YAML frontmatter.');
  }
  const [, open, fmBody, close, body] = fmMatch;

  // Bump entryCount (default 0 → 1) and updated; preserve everything else.
  let newFm = fmBody;
  const countMatch = newFm.match(/^entryCount:\s*(\d+)\s*$/m);
  const nextCount = countMatch ? parseInt(countMatch[1], 10) + 1 : 1;
  if (countMatch) {
    newFm = newFm.replace(/^entryCount:\s*\d+\s*$/m, `entryCount: ${nextCount}`);
  } else {
    newFm = `${newFm}\nentryCount: ${nextCount}`;
  }
  if (/^updated:\s*.*$/m.test(newFm)) {
    newFm = newFm.replace(/^updated:\s*.*$/m, `updated: "${now}"`);
  } else {
    newFm = `${newFm}\nupdated: "${now}"`;
  }

  const entryBlock = formatProgressEntry(entry, now);

  // Body handling: drop the placeholder, then insert the new entry right after the
  // `# Progress` H1 so newest is first.
  let newBody = body.replace(/\n?No progress yet\.\s*\n?/, '\n');
  const h1 = newBody.match(/^#\sProgress\s*$/m);
  if (h1) {
    const idx = newBody.indexOf(h1[0]) + h1[0].length;
    const before = newBody.slice(0, idx).replace(/\s*$/, '');
    const after = newBody.slice(idx).replace(/^\s*/, '');
    newBody = `${before}\n\n${entryBlock}${after.length > 0 ? `\n${after}` : ''}`;
  } else {
    newBody = `# Progress\n\n${entryBlock}${newBody.trim().length > 0 ? `\n${newBody.trim()}\n` : ''}`;
  }
  if (!newBody.endsWith('\n')) newBody += '\n';

  return `${open}${newFm}${close.startsWith('\n') ? close : `\n${close}`}${newBody}`;
}

export interface AppendProgressLogInput {
  ticketDir: string;
  ticketRef: string;
  text: string;
}

/** Read-or-scaffold `progress.md`, append one entry, write atomically. */
export async function appendProgressLog(
  input: AppendProgressLogInput,
): Promise<{ path: string; timestamp: string }> {
  const path = resolve(input.ticketDir, 'progress.md');
  const now = nowTimestamp();

  const content = (await fileExists(path))
    ? await readFile(path, 'utf-8')
    : renderProgress({ ticket: input.ticketRef, timestamp: now });

  const next = appendProgressEntry(content, input.text, now);
  await writeFileForce(path, next);
  return { path, timestamp: now };
}
