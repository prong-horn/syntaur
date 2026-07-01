import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { extractFrontmatter, getNestedField } from '../dashboard/parser.js';
import type {
  AgentConfig,
  AgentSourceKind,
  RunnerKind,
} from '../utils/agents-schema.js';
import { discoverClaudeAgents, type DiscoveredAgent } from './agent-definitions.js';

/**
 * A discovered, not-yet-registered agent candidate for the "click to register"
 * tray. `path` is the `.md` file for a claude candidate or the directory for a
 * directory candidate. `recommended` is true when the def carries a `syntaur:`
 * frontmatter opt-in (ranked first). `alreadyRegistered` de-clutters the tray.
 */
export interface DiscoveredCandidate {
  name: string;
  runner: RunnerKind;
  description?: string;
  path: string;
  source: AgentSourceKind;
  /** For `claude-project`: the repo root the def belongs to (Decision 3). */
  sourceRepo?: string;
  recommended: boolean;
  alreadyRegistered: boolean;
}

export interface DiscoverAgentsInput {
  /** Scan `~/.claude/agents` for claude candidates. */
  claudeGlobal: boolean;
  /** Scan `<repo>/.claude/agents` (and per-dir `.claude/agents` in roots). */
  claudeProject: boolean;
  /** Scan `roots` depth-1 for directory (pi/codex) agent dirs. */
  directory: boolean;
  /** Directory-scan roots; may contain `~` (expanded here). */
  roots: string[];
  /** Current workspace repo root, for the claude-project source. */
  repo?: string | null;
  /** Registered agents, used to compute `alreadyRegistered`. */
  agents: AgentConfig[];
}

interface SyntaurMeta {
  name?: string;
  runner?: RunnerKind;
  description?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function coerceRunner(raw: string | undefined): RunnerKind | undefined {
  return raw === 'claude' || raw === 'pi' || raw === 'codex' ? raw : undefined;
}

/**
 * Read a `syntaur:` frontmatter opt-in block from a def file. Returns null when
 * the file is unreadable, has no frontmatter, or carries no (block-form)
 * `syntaur:` key — so a bare `AGENTS.md` (no opt-in) is NOT treated as an agent.
 */
async function readSyntaurMeta(file: string): Promise<SyntaurMeta | null> {
  let content: string;
  try {
    content = await readFile(file, 'utf-8');
  } catch {
    return null;
  }
  const [fm] = extractFrontmatter(content);
  if (!fm) return null;
  // Block-form `syntaur:` on its own line (children indented). Inline forms are
  // intentionally unsupported (parity with getNestedField).
  if (!/^syntaur:[ \t]*$/m.test(fm)) return null;
  return {
    name: getNestedField(fm, 'syntaur', 'name')?.trim() || undefined,
    runner: coerceRunner(getNestedField(fm, 'syntaur', 'runner')?.trim() || undefined),
    description: getNestedField(fm, 'syntaur', 'description')?.trim() || undefined,
  };
}

async function fileHasSyntaurBlock(file: string): Promise<boolean> {
  return (await readSyntaurMeta(file)) !== null;
}

function claudeAlreadyRegistered(
  agents: AgentConfig[],
  path: string,
  name: string,
): boolean {
  return agents.some((a) => a.sourcePath === path || (!!a.agentName && a.agentName === name));
}

function directoryAlreadyRegistered(agents: AgentConfig[], dir: string): boolean {
  return agents.some((a) => a.sourcePath === dir || a.workdir === dir);
}

async function toClaudeCandidate(
  d: DiscoveredAgent,
  source: AgentSourceKind,
  agents: AgentConfig[],
  sourceRepo?: string,
): Promise<DiscoveredCandidate> {
  return {
    name: d.name,
    runner: 'claude',
    description: d.description,
    path: d.path,
    source,
    ...(sourceRepo ? { sourceRepo } : {}),
    recommended: await fileHasSyntaurBlock(d.path),
    alreadyRegistered: claudeAlreadyRegistered(agents, d.path, d.name),
  };
}

/**
 * Inspect a depth-1 directory for a DIRECTORY (pi/codex) agent. Strong-marker
 * policy: surfaced only when it has `.pi/`, `.mcp.json`, or an
 * `AGENTS.md`/`SYNTAUR.md` carrying a `syntaur:` block. A bare `AGENTS.md`
 * (no opt-in) returns null (reachable via manual-add). Runner inferred:
 * `syntaur.runner` wins, else `.pi/` ⇒ pi, else default pi (confirmed on register).
 */
async function inspectDirCandidate(
  dir: string,
  basename: string,
  agents: AgentConfig[],
): Promise<DiscoveredCandidate | null> {
  const hasPi = await pathExists(join(dir, '.pi'));
  const hasMcp = await pathExists(join(dir, '.mcp.json'));
  const hasSyntaurMd = await pathExists(join(dir, 'SYNTAUR.md'));
  const hasAgentsMd = await pathExists(join(dir, 'AGENTS.md'));

  let syntaur: SyntaurMeta | null = null;
  if (hasSyntaurMd) syntaur = await readSyntaurMeta(join(dir, 'SYNTAUR.md'));
  if (!syntaur && hasAgentsMd) syntaur = await readSyntaurMeta(join(dir, 'AGENTS.md'));

  const strong = hasPi || hasMcp || syntaur !== null;
  if (!strong) return null;

  return {
    name: syntaur?.name ?? basename,
    // A directory agent is pi/codex by definition; a contradictory
    // `syntaur.runner: claude` opt-in is clamped to pi so the candidate never
    // carries an impossible directory+claude combo.
    runner: syntaur?.runner === 'codex' ? 'codex' : 'pi',
    description: syntaur?.description,
    path: dir,
    source: 'directory',
    recommended: syntaur !== null,
    alreadyRegistered: directoryAlreadyRegistered(agents, dir),
  };
}

/**
 * Discover agent candidates across the enabled sources for the register tray.
 * Never throws on a missing/unreadable path — it simply contributes nothing.
 * Result is deduped by (source, path, name) and sorted recommended-first,
 * then by name.
 */
export async function discoverAgents(
  input: DiscoverAgentsInput,
): Promise<DiscoveredCandidate[]> {
  const out: DiscoveredCandidate[] = [];

  if (input.claudeGlobal) {
    for (const d of await discoverClaudeAgents()) {
      out.push(await toClaudeCandidate(d, 'claude-global', input.agents));
    }
  }

  if (input.claudeProject && input.repo) {
    const projRoot = join(input.repo, '.claude', 'agents');
    for (const d of await discoverClaudeAgents(projRoot)) {
      out.push(await toClaudeCandidate(d, 'claude-project', input.agents, input.repo));
    }
  }

  // The roots scan feeds the directory source AND the per-dir claude-project
  // source. claude-project is decoupled from the `directory` toggle so enabling
  // it alone still surfaces a repo's `.claude/agents` (there is no single
  // workspace→repo mapping — a workspace groups multiple repos — so the current
  // repo isn't threaded from the UI; repos living under a scan root are covered
  // here, and `input.repo` covers an explicit one above).
  if (input.directory || input.claudeProject) {
    for (const rawRoot of input.roots) {
      const root = expandHome(rawRoot);
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue; // missing/unreadable root → contributes nothing
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = join(root, e.name);

        if (input.directory) {
          const dirCand = await inspectDirCandidate(dir, e.name, input.agents);
          if (dirCand) out.push(dirCand);
        }

        // Per-dir project-level claude agents (the `.claude/agents/` marker):
        // the dir's INNER claude defs are surfaced as claude-project candidates
        // (the dir itself is not a directory-agent unless it has its own marker).
        if (input.claudeProject && (await pathExists(join(dir, '.claude', 'agents')))) {
          const projRoot = join(dir, '.claude', 'agents');
          for (const d of await discoverClaudeAgents(projRoot)) {
            out.push(await toClaudeCandidate(d, 'claude-project', input.agents, dir));
          }
        }
      }
    }
  }

  const seen = new Set<string>();
  const deduped: DiscoveredCandidate[] = [];
  for (const c of out) {
    const key = JSON.stringify([c.source, c.path, c.name]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  deduped.sort((a, b) =>
    a.recommended === b.recommended
      ? a.name.localeCompare(b.name)
      : a.recommended
        ? -1
        : 1,
  );
  return deduped;
}
