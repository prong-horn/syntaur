import { mkdir, writeFile, access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { extractFrontmatter, getField, getNestedField } from '../dashboard/parser.js';
import {
  AGENT_ID_PATTERN,
  type AgentConfig,
  type AgentSourceKind,
  type RunnerKind,
} from '../utils/agents-schema.js';

export const RUNNER_COMMAND: Record<RunnerKind, string> = {
  claude: 'claude',
  pi: 'pi',
  codex: 'codex',
};

/**
 * Expand `~` and require an absolute path. Persisted paths (register/manual-add
 * source, create location, standalone cwd) must be absolute so they resolve the
 * same regardless of the server's cwd — a relative path would be resolved
 * against the dashboard process, which is never what the user means.
 */
export function requireAbsolutePath(raw: string, what = 'path'): string {
  const p = expandHome(raw.trim());
  if (!isAbsolute(p)) {
    throw new Error(`${what} must be an absolute path (got ${JSON.stringify(raw)})`);
  }
  return p;
}

/** Slugify a display name into a valid agent id (`^[a-z0-9][a-z0-9_-]*$`). */
export function slugifyAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const safe = /^[a-z0-9]/.test(slug) ? slug : `agent-${slug}`;
  return AGENT_ID_PATTERN.test(safe) ? safe : 'agent';
}

/** Make an id unique against `existingIds` by appending -2, -3, … */
export function uniqueAgentId(base: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface RegisteredAgentInput {
  name: string;
  runner: RunnerKind;
  sourceKind: AgentSourceKind;
  sourcePath: string;
  sourceRepo?: string | null;
  description?: string | null;
  existingIds: Iterable<string>;
}

/**
 * Build a thin registered `AgentConfig` from a discovered/confirmed candidate.
 * A claude agent carries `agentName` (the `--agent <name>`); a directory agent
 * carries `workdir` (= its source dir). The on-disk def stays the source of truth
 * for identity content; `source*` is the pointer.
 */
export function buildRegisteredAgent(input: RegisteredAgentInput): AgentConfig {
  const id = uniqueAgentId(slugifyAgentId(input.name), input.existingIds);
  const agent: AgentConfig = {
    id,
    label: input.name,
    command: RUNNER_COMMAND[input.runner],
    runner: input.runner,
    sourceKind: input.sourceKind,
    sourcePath: input.sourcePath,
  };
  if (input.sourceRepo) agent.sourceRepo = input.sourceRepo;
  if (input.runner === 'claude') {
    agent.agentName = input.name;
  } else {
    agent.workdir = input.sourcePath;
  }
  return agent;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function frontmatterLines(fields: Record<string, string | undefined>): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== '') lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  return lines;
}

function syntaurBlock(name: string, runner: RunnerKind, description?: string): string[] {
  const lines = ['syntaur:', `  name: ${JSON.stringify(name)}`, `  runner: ${runner}`];
  if (description) lines.push(`  description: ${JSON.stringify(description)}`);
  return lines;
}

export interface AuthorAgentInput {
  name: string;
  runner: RunnerKind;
  model?: string;
  description?: string;
  instructions: string;
  /**
   * For claude: an agents dir (absolute/`~`) → claude-project; omitted → global
   * `~/.claude/agents`. For a directory agent: the parent dir the `<slug>/` is
   * scaffolded under (omitted → home).
   */
  location?: string;
}

export interface AuthoredDef {
  path: string;
  sourceKind: AgentSourceKind;
  sourceRepo?: string;
}

/**
 * Author a runner-native agent definition on disk (with a `syntaur:` opt-in
 * block so it re-discovers cleanly), returning its path + source pointer. Refuses
 * to overwrite an existing path.
 */
export async function authorAgentDef(input: AuthorAgentInput): Promise<AuthoredDef> {
  const slug = slugifyAgentId(input.name);
  if (input.runner === 'claude') {
    const dir = input.location
      ? requireAbsolutePath(input.location, 'location')
      : join(homedir(), '.claude', 'agents');
    const path = join(dir, `${slug}.md`);
    if (await pathExists(path)) {
      throw new Error(`refusing to overwrite existing def at ${path}`);
    }
    const fm = [
      '---',
      ...frontmatterLines({
        name: input.name,
        description: input.description,
        model: input.model,
      }),
      ...syntaurBlock(input.name, 'claude', input.description),
      '---',
    ];
    await mkdir(dir, { recursive: true });
    await writeFile(path, `${fm.join('\n')}\n\n${input.instructions.trim()}\n`);
    return { path, sourceKind: input.location ? 'claude-project' : 'claude-global' };
  }

  // Directory agent: scaffold <parent>/<slug>/AGENTS.md
  const parent = input.location ? requireAbsolutePath(input.location, 'location') : homedir();
  const dir = join(parent, slug);
  const agentsMd = join(dir, 'AGENTS.md');
  if (await pathExists(agentsMd)) {
    throw new Error(`refusing to overwrite existing def at ${agentsMd}`);
  }
  const fm = ['---', ...syntaurBlock(input.name, input.runner, input.description), '---'];
  await mkdir(dir, { recursive: true });
  await writeFile(agentsMd, `${fm.join('\n')}\n\n${input.instructions.trim()}\n`);
  return { path: dir, sourceKind: 'directory' };
}

/**
 * Infer a runner + name for a manual-add of an arbitrary path (the always-works
 * fallback). A `.md` file → a claude def (name from frontmatter). A directory →
 * a directory agent (`.pi/` ⇒ pi, else `syntaur.runner`, else pi; name from
 * `syntaur:`/`AGENTS.md`/basename).
 */
export async function inferManualAdd(rawPath: string): Promise<{
  name: string;
  runner: RunnerKind;
  sourceKind: AgentSourceKind;
  sourcePath: string;
  description?: string;
}> {
  const path = requireAbsolutePath(rawPath);
  const info = await stat(path); // throws if missing → caller surfaces
  if (info.isFile()) {
    const content = await readFile(path, 'utf-8');
    const [fm] = extractFrontmatter(content);
    const name =
      getNestedField(fm, 'syntaur', 'name')?.trim() ||
      getField(fm, 'name')?.trim() ||
      basename(path).replace(/\.md$/, '');
    const description =
      getNestedField(fm, 'syntaur', 'description')?.trim() ||
      getField(fm, 'description')?.trim() ||
      undefined;
    return { name, runner: 'claude', sourceKind: 'claude-global', sourcePath: path, description };
  }
  // directory
  const hasPi = await pathExists(join(path, '.pi'));
  let syntaurName: string | undefined;
  let syntaurRunner: RunnerKind | undefined;
  let syntaurDesc: string | undefined;
  for (const f of ['SYNTAUR.md', 'AGENTS.md']) {
    const p = join(path, f);
    if (await pathExists(p)) {
      const [fm] = extractFrontmatter(await readFile(p, 'utf-8'));
      syntaurName = getNestedField(fm, 'syntaur', 'name')?.trim() || syntaurName;
      const r = getNestedField(fm, 'syntaur', 'runner')?.trim();
      if (r === 'claude' || r === 'pi' || r === 'codex') syntaurRunner = r;
      syntaurDesc = getNestedField(fm, 'syntaur', 'description')?.trim() || syntaurDesc;
      if (syntaurName || syntaurRunner) break;
    }
  }
  return {
    name: syntaurName ?? basename(path),
    runner: syntaurRunner ?? (hasPi ? 'pi' : 'pi'),
    sourceKind: 'directory',
    sourcePath: path,
    description: syntaurDesc,
  };
}
