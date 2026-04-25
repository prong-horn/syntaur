import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from './fs.js';
import { parsePlaybook, type ParsedPlaybook } from '../dashboard/parser.js';
import { nowTimestamp } from './timestamp.js';
import { readConfig, updatePlaybooksConfig } from './config.js';

export interface ResolvedPlaybook {
  filename: string;
  slug: string;
  parsed: ParsedPlaybook;
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
