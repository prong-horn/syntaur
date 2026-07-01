import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractFrontmatter, getField } from '../dashboard/parser.js';
import { getAgentTarget } from './registry.js';

/**
 * A Claude agent definition discovered on disk (`~/.claude/agents/**\/*.md`).
 * The `name` is what `claude --agent <name>` expects; `model` is the agent's own
 * frontmatter model (authoritative on `--agent`, shown read-only in the UI).
 */
export interface DiscoveredAgent {
  name: string;
  description?: string;
  model?: string;
  /** Absolute path to the defining markdown file. */
  path: string;
}

/**
 * Recursively collect `*.md` files under `dir`. Mirrors the existing
 * `readdir(dir, { withFileTypes: true })` walkers (there is no glob dependency).
 * A missing/unreadable directory yields nothing rather than throwing.
 */
async function collectMarkdown(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing dir or permission error → contributes no files
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
}

/**
 * Discover Claude agent definitions for the `--agent <name>` identity picker.
 *
 * Recurses `root` (defaults to the Claude target's `agentsDir`,
 * `~/.claude/agents`), parses each `*.md` file's frontmatter with the shared
 * dashboard parser, and returns the agents with a non-empty `name`. Files with
 * no/invalid frontmatter or no `name` are skipped. Duplicates by `name` keep the
 * first seen (sorted-path order); the result is sorted by `name`. A missing
 * `agentsDir` (Claude not installed, or no agents dir) returns `[]`.
 */
export async function discoverClaudeAgents(root?: string): Promise<DiscoveredAgent[]> {
  const dir = root ?? getAgentTarget('claude')?.agentsDir;
  if (!dir) return [];

  const files: string[] = [];
  await collectMarkdown(dir, files);
  files.sort(); // deterministic first-wins dedupe regardless of FS order

  const byName = new Map<string, DiscoveredAgent>();
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const [frontmatter] = extractFrontmatter(content);
    if (!frontmatter) continue; // no/invalid frontmatter
    const name = getField(frontmatter, 'name')?.trim();
    if (!name) continue;
    if (byName.has(name)) continue; // first wins
    const description = getField(frontmatter, 'description')?.trim() || undefined;
    const model = getField(frontmatter, 'model')?.trim() || undefined;
    byName.set(name, { name, description, model, path: file });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
