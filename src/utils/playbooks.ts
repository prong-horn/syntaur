import { resolve } from 'node:path';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { fileExists, writeFileForce } from './fs.js';
import { parsePlaybook, type ParsedPlaybook } from '../dashboard/parser.js';
import { nowTimestamp } from './timestamp.js';
import { readConfig, updatePlaybooksConfig } from './config.js';
import { isValidSlug } from './slug.js';

export interface ResolvedPlaybook {
  filename: string;
  slug: string;
  parsed: ParsedPlaybook;
}

export type PlaybookErrorCode = 'manifest' | 'not-found' | 'invalid-slug' | 'collision';

/**
 * Stable error thrown by playbook helpers. Routers and CLI commands branch on
 * `code` to map to HTTP status / exit code without string matching.
 */
export class PlaybookError extends Error {
  readonly code: PlaybookErrorCode;
  constructor(code: PlaybookErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'PlaybookError';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace or insert a frontmatter scalar field. Playbook files always have
 * frontmatter (parsePlaybook depends on it). If the field is absent, insert it
 * just before the closing `---`. Values are written verbatim (caller decides
 * quoting).
 */
function setFrontmatterField(content: string, key: string, value: string): string {
  const regex = new RegExp(`^(${escapeRegExp(key)}:)\\s*.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `$1 ${value}`);
  }
  const closingIdx = content.indexOf('\n---', 4);
  if (closingIdx === -1) {
    return content;
  }
  return `${content.slice(0, closingIdx)}\n${key}: ${value}${content.slice(closingIdx)}`;
}

function isVisiblePlaybookFile(name: string, isFile: boolean): boolean {
  return isFile && name.endsWith('.md') && !name.startsWith('_') && name !== 'manifest.md';
}

/**
 * Resolve a requested slug to a concrete playbook file.
 *
 * Canonical slug is the `slug` field in the playbook's frontmatter. If that
 * field is missing we fall back to the filename stem. This means a playbook
 * with `filename: foo.md` and frontmatter `slug: bar` is reachable by `bar`
 * (and NOT by `foo`) — this keeps behavior consistent across dashboard +
 * CLI so enable/disable state is addressable by a single canonical slug.
 */
export async function resolvePlaybookSlug(
  playbooksDir: string,
  slug: string,
): Promise<ResolvedPlaybook | null> {
  if (!(await fileExists(playbooksDir))) return null;

  const entries = await readdir(playbooksDir, { withFileTypes: true });

  let filenameStemFallback: ResolvedPlaybook | null = null;

  for (const entry of entries) {
    if (!isVisiblePlaybookFile(entry.name, entry.isFile())) continue;

    const filePath = resolve(playbooksDir, entry.name);
    const raw = await readFile(filePath, 'utf-8');
    const parsed = parsePlaybook(raw);
    const canonical = parsed.slug || entry.name.replace(/\.md$/, '');

    if (canonical === slug) {
      return { filename: entry.name, slug: canonical, parsed };
    }

    // Only use the filename stem as a fallback when frontmatter slug is absent.
    if (!parsed.slug && entry.name.replace(/\.md$/, '') === slug) {
      filenameStemFallback = { filename: entry.name, slug: canonical, parsed };
    }
  }

  return filenameStemFallback;
}

/**
 * Toggle a playbook's enabled/disabled state. Writes config.md, rebuilds the
 * manifest, and returns the canonical slug + resulting enabled flag.
 *
 * Throws if the slug cannot be resolved to a playbook file.
 */
export async function setPlaybookEnabled(
  playbooksDir: string,
  slug: string,
  enabled: boolean,
): Promise<{ slug: string; enabled: boolean; changed: boolean }> {
  const resolved = await resolvePlaybookSlug(playbooksDir, slug);
  if (!resolved) {
    throw new Error(`Playbook "${slug}" not found in ${playbooksDir}`);
  }

  const config = await readConfig();
  const disabledSet = new Set(config.playbooks.disabled);
  const wasDisabled = disabledSet.has(resolved.slug);
  const shouldBeDisabled = !enabled;

  if (wasDisabled === shouldBeDisabled) {
    return { slug: resolved.slug, enabled, changed: false };
  }

  if (shouldBeDisabled) {
    disabledSet.add(resolved.slug);
  } else {
    disabledSet.delete(resolved.slug);
  }

  await updatePlaybooksConfig({ disabled: Array.from(disabledSet).sort() });
  await rebuildPlaybookManifest(playbooksDir);

  return { slug: resolved.slug, enabled, changed: true };
}

/**
 * Load a playbook ONLY if it is enabled. Returns null when the playbook does
 * not exist OR is disabled in config. Intended for agent-facing lookups that
 * must respect the disabled state.
 *
 * Dashboard admin code should NOT use this — it uses the unfiltered
 * `getPlaybookDetail` so admins can still see and re-enable disabled playbooks.
 */
export async function loadEnabledPlaybook(
  playbooksDir: string,
  slug: string,
): Promise<ParsedPlaybook | null> {
  const resolved = await resolvePlaybookSlug(playbooksDir, slug);
  if (!resolved) return null;

  const config = await readConfig();
  if (config.playbooks.disabled.includes(resolved.slug)) {
    return null;
  }

  return resolved.parsed;
}

/**
 * Remove a slug from the disabled list. Called when a playbook is deleted so
 * a later reincarnation with the same slug doesn't silently start disabled.
 * No-op if the slug isn't currently disabled.
 */
export async function removeFromDisabledList(slug: string): Promise<void> {
  const config = await readConfig();
  if (!config.playbooks.disabled.includes(slug)) return;
  await updatePlaybooksConfig({
    disabled: config.playbooks.disabled.filter((s) => s !== slug),
  });
}

export async function rebuildPlaybookManifest(playbooksDir: string): Promise<void> {
  if (!(await fileExists(playbooksDir))) return;

  const config = await readConfig();
  const disabledSet = new Set(config.playbooks.disabled);

  const entries = await readdir(playbooksDir, { withFileTypes: true });
  const rows: Array<{ name: string; slug: string; description: string; whenToUse: string }> = [];

  for (const entry of entries) {
    if (!isVisiblePlaybookFile(entry.name, entry.isFile())) continue;

    const raw = await readFile(resolve(playbooksDir, entry.name), 'utf-8');
    const parsed = parsePlaybook(raw);
    const slug = parsed.slug || entry.name.replace(/\.md$/, '');

    if (disabledSet.has(slug)) continue;

    rows.push({
      name: parsed.name || slug,
      slug,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const timestamp = nowTimestamp();
  const lines = [
    '---',
    `generated: "${timestamp}"`,
    `total: ${rows.length}`,
    '---',
    '',
    '# Playbooks',
    '',
    'Behavioral rules for AI agents. Read and follow all playbooks before starting work.',
    '',
  ];

  for (const row of rows) {
    lines.push(`- **[${row.name}](${row.slug}.md)** — ${row.description}`);
    if (row.whenToUse) {
      lines.push(`  _When to use: ${row.whenToUse}_`);
    }
  }

  lines.push('');

  await writeFileForce(resolve(playbooksDir, 'manifest.md'), lines.join('\n'));
}

/**
 * Delete a playbook file from disk and regenerate the manifest. Refuses
 * `manifest`. Drops the slug from `config.playbooks.disabled` if present so a
 * later recreation with the same slug doesn't silently start disabled. Throws
 * `PlaybookError` on `manifest` / `not-found`.
 *
 * Shared by `DELETE /api/playbooks/:slug` and `syntaur delete-playbook`.
 */
export async function deletePlaybook(
  playbooksDir: string,
  slug: string,
): Promise<{ slug: string }> {
  if (slug === 'manifest') {
    throw new PlaybookError('manifest', 'The playbook manifest cannot be deleted.');
  }

  const resolved = await resolvePlaybookSlug(playbooksDir, slug);
  if (!resolved) {
    throw new PlaybookError('not-found', `Playbook "${slug}" not found.`);
  }

  await unlink(resolve(playbooksDir, resolved.filename));
  await removeFromDisabledList(resolved.slug);
  await rebuildPlaybookManifest(playbooksDir);

  return { slug: resolved.slug };
}

/**
 * Rename a playbook to a new slug. Validates the new slug, refuses `manifest`,
 * and rejects collisions at both filename and canonical-slug levels. Updates
 * the on-disk file's frontmatter `slug:` field. Migrates the disabled-list
 * entry if needed. Regenerates the manifest.
 *
 * Special case: if `oldPath === newPath` (e.g., file is `foo.md` with
 * frontmatter `slug: bar`, caller renames `bar -> foo`), rewrite the file in
 * place without unlinking. Returns `renamedInPlace: true` in that case.
 */
export async function renamePlaybook(
  playbooksDir: string,
  oldSlug: string,
  newSlug: string,
): Promise<{ from: string; to: string; renamedInPlace: boolean }> {
  if (!isValidSlug(newSlug)) {
    throw new PlaybookError(
      'invalid-slug',
      `Invalid slug "${newSlug}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }
  if (newSlug === 'manifest') {
    throw new PlaybookError('manifest', 'A playbook cannot be named "manifest".');
  }

  const resolved = await resolvePlaybookSlug(playbooksDir, oldSlug);
  if (!resolved) {
    throw new PlaybookError('not-found', `Playbook "${oldSlug}" not found.`);
  }

  const oldPath = resolve(playbooksDir, resolved.filename);
  const newPath = resolve(playbooksDir, `${newSlug}.md`);

  // Rename-in-place: e.g., file `foo.md` with `slug: bar` renamed `bar -> foo`.
  // The on-disk filename doesn't change; only the frontmatter slug field does.
  const renamedInPlace = oldPath === newPath;

  if (!renamedInPlace) {
    // Filename collision: another file already occupies the new path.
    if (await fileExists(newPath)) {
      throw new PlaybookError(
        'collision',
        `A playbook file already exists at "${newSlug}.md".`,
      );
    }
    // Canonical-slug collision: another file declares this slug in its frontmatter.
    const existing = await resolvePlaybookSlug(playbooksDir, newSlug);
    if (existing && resolve(playbooksDir, existing.filename) !== oldPath) {
      throw new PlaybookError(
        'collision',
        `Another playbook already uses the canonical slug "${newSlug}".`,
      );
    }
  }

  const raw = await readFile(oldPath, 'utf-8');
  let next = setFrontmatterField(raw, 'slug', newSlug);
  next = setFrontmatterField(next, 'updated', `"${nowTimestamp()}"`);

  await writeFileForce(newPath, next);
  if (!renamedInPlace) {
    await unlink(oldPath);
  }

  // Migrate disabled-list entry if the old canonical slug was disabled.
  const config = await readConfig();
  if (config.playbooks.disabled.includes(resolved.slug)) {
    const nextDisabled = config.playbooks.disabled
      .filter((s) => s !== resolved.slug)
      .concat(newSlug);
    await updatePlaybooksConfig({ disabled: Array.from(new Set(nextDisabled)).sort() });
  }

  await rebuildPlaybookManifest(playbooksDir);

  return { from: resolved.slug, to: newSlug, renamedInPlace };
}
