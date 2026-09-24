import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  access,
  copyFile,
  lstat,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Command } from 'commander';
import { isSyntaurPluginKey } from '../utils/claude-plugin-key.js';
import {
  RETIRED_CONFIG_KEYS,
  removeRetiredConfigKeys,
} from '../utils/config.js';
import { KNOWN_TOP_LEVEL } from '../utils/doctor/checks/structure.js';
import { SYNTAUR_PACK_SKILL_NAMES } from '../utils/doctor/checks/skills.js';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { readJsonFile, writeJsonFileAtomic } from '../utils/json-file.js';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { readPackageVersion } from '../utils/version.js';
import {
  pendingMigrationSteps,
  readMarkerSteps,
  V2_MIGRATED_MARKER,
} from './migrate-v2.js';

export type LeftoverCategory =
  | 'claude-plugin'
  | 'agent-plugin'
  | 'skill'
  | 'launch-agent'
  | 'url-handler'
  | 'home-entry'
  | 'config'
  | 'runtime';

export type LeftoverKind =
  | 'move'
  | 'json-edit'
  | 'config-edit'
  | 'delete'
  | 'info'
  | 'blocked';

export interface Leftover {
  category: LeftoverCategory;
  kind: LeftoverKind;
  path: string;
  detail: string;
  jsonKey?: string;
  configKey?: string;
  launchLabel?: string;
}

export type CleanupRunner = (
  command: string,
  args: string[],
) => SpawnSyncReturns<string>;

export interface CleanupDeps {
  homeDir: string;
  syntaurHome: string;
  platform: NodeJS.Platform;
  uid: number;
  env: NodeJS.ProcessEnv;
  tmpDir: string;
  runner: CleanupRunner;
  now: () => Date;
}

export interface CleanupResult {
  moved: number;
  edited: number;
  deleted: number;
  blocked: number;
  retiredDir: string | null;
}

/** Retired skill directory names (pre skills.sh six-pack). */
export const RETIRED_SKILL_NAMES = [
  'create-mission',
  'grab-assignment',
  'plan-assignment',
  'complete-assignment',
  'create-assignment',
  'track-session',
  'clear-assignment',
  'create-project',
  'manage-statuses',
  'save-session-summary',
  'track-server',
  'capture-artifacts',
  'add-memory',
  'add-resource',
  'list-assignments',
  'log-progress',
  'replan',
  'resume-session',
  'set-workspace',
  'syntaur-worktree',
  'claim-resource',
  'release-resource',
  'extend-resource',
  'list-resources',
  'bundle-worktree',
  'complete-bundle',
  'grab-bundle',
  'plan-bundle',
  'run-playbook',
  'views',
  'manage-workflows',
  'grab-ticket',
  'plan-ticket',
  'complete-ticket',
  'create-ticket',
  'project-new',
  'clear-ticket',
  'list-tickets',
  'doctor-syntaur',
] as const;

/** Top-level ~/.syntaur names retired by migrate cleanup. */
export const RETIRED_HOME_ENTRIES = [
  'missions',
  'assignments',
  'tickets',
  'todos',
  'servers',
  'schedules',
  'logs',
  'workflows',
  'jobs',
  'targets',
  'recording.json',
  'recording.log',
  'recording.pid',
  'saved-views.json',
  'workspaces.json',
  'tier3-violations.log',
  'daemon.log',
  'derive-migrated',
  'stages-migrated',
  'install-launch-agent.lock',
  'install-url-handler.lock',
  '.backup-lock',
  'daemon',
] as const;

// docs/releases/v1.0.md:98-99; docs/superpowers/specs/2026-06-14-scheduled-agents-design.md:46
export const RETIRED_LAUNCH_AGENT_LABELS = [
  'com.syntaur.schedule.tick',
  'com.syntaur.session.scan',
] as const;

const URL_HANDLER_BUNDLE_ID = 'app.syntaur.url-handler';
const RETIRED_SKILL_SET = new Set<string>(RETIRED_SKILL_NAMES);
const CURRENT_SKILL_SET = new Set<string>(SYNTAUR_PACK_SKILL_NAMES);

for (const name of RETIRED_HOME_ENTRIES) {
  if (KNOWN_TOP_LEVEL.has(name)) {
    throw new Error(`RETIRED_HOME_ENTRIES overlaps KNOWN_TOP_LEVEL: ${name}`);
  }
}
for (const name of RETIRED_SKILL_NAMES) {
  if (CURRENT_SKILL_SET.has(name)) {
    throw new Error(`RETIRED_SKILL_NAMES overlaps current pack: ${name}`);
  }
}

function defaultRunner(command: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: 'utf-8' });
}

export function defaultCleanupDeps(): CleanupDeps {
  return {
    homeDir: homedir(),
    syntaurHome: syntaurRoot(),
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    env: process.env,
    tmpDir: '/tmp',
    runner: defaultRunner,
    now: () => new Date(),
  };
}

export function legacyRuntimeDir(deps: CleanupDeps): string {
  const override = deps.env.SYNTAUR_RUNTIME_DIR;
  if (override && override.length > 0) return resolve(expandHome(override));
  return resolve(deps.tmpDir, `syntaur-${deps.uid}`);
}

export function isActionableLeftover(item: Leftover): boolean {
  return item.kind !== 'info';
}

function hermesHome(deps: CleanupDeps): string {
  const env = deps.env.HERMES_HOME;
  return env && env.length > 0 ? resolve(expandHome(env)) : resolve(deps.homeDir, '.hermes');
}

function categoryHeader(category: LeftoverCategory): string {
  switch (category) {
    case 'claude-plugin':
      return 'Claude Code plugin';
    case 'agent-plugin':
      return 'Codex / other agent plugins';
    case 'skill':
      return 'Retired skills';
    case 'launch-agent':
      return 'LaunchAgents';
    case 'url-handler':
      return 'URL handler';
    case 'home-entry':
      return 'Retired ~/.syntaur entries';
    case 'config':
      return 'Retired config.md keys';
    case 'runtime':
      return 'Daemon runtime';
    default:
      return category;
  }
}

const CATEGORY_ORDER: LeftoverCategory[] = [
  'claude-plugin',
  'agent-plugin',
  'skill',
  'launch-agent',
  'url-handler',
  'home-entry',
  'config',
  'runtime',
];

function retiredRelativePath(homeDir: string, absPath: string): string {
  const relHome = relative(homeDir, absPath);
  if (relHome && !relHome.startsWith('..') && !isAbsolute(relHome)) {
    return relHome;
  }
  const normalized = absPath.replace(/^\//, '');
  return `_abs/${normalized}`;
}

async function dirIsEmptyOrDsStore(dirPath: string): Promise<boolean> {
  if (!(await fileExists(dirPath))) return false;
  const entries = await readdir(dirPath);
  return entries.every((e) => e === '.DS_Store');
}

async function readText(path: string): Promise<string | null> {
  if (!(await fileExists(path))) return null;
  return readFile(path, 'utf-8');
}

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function readInstallMarker(dir: string): Promise<{ packageName?: string; pluginKind?: string } | null> {
  const raw = await readText(resolve(dir, '.syntaur-install.json'));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { packageName?: string; pluginKind?: string };
  } catch {
    return null;
  }
}

async function readPluginNameFromManifest(dir: string): Promise<string | null> {
  for (const rel of ['.claude-plugin/plugin.json', 'plugin.json', '.codex-plugin/plugin.json']) {
    const raw = await readText(resolve(dir, rel));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { name?: string };
      if (typeof parsed.name === 'string') return parsed.name;
    } catch {
      continue;
    }
  }
  return null;
}

async function ownsClaudePluginPath(entryPath: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(entryPath);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    try {
      const target = await readlink(entryPath);
      const resolved = isAbsolute(target) ? target : resolve(dirname(entryPath), target);
      const name = await readPluginNameFromManifest(resolved);
      if (name === 'syntaur') return true;
    } catch {
      return basename(entryPath) === 'syntaur' && entryPath.includes(`${join('plugins', 'syntaur')}`);
    }
    return basename(entryPath) === 'syntaur';
  }
  if (!st.isDirectory()) return false;
  const marker = await readInstallMarker(entryPath);
  if (marker?.packageName === 'syntaur' && marker.pluginKind === 'claude') return true;
  const name = await readPluginNameFromManifest(entryPath);
  return name === 'syntaur';
}

async function ownsAgentPluginPath(entryPath: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(entryPath);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    try {
      const target = await readlink(entryPath);
      const resolved = isAbsolute(target) ? target : resolve(dirname(entryPath), target);
      const marker = await readInstallMarker(resolved);
      if (marker?.packageName === 'syntaur') return true;
      const name = await readPluginNameFromManifest(resolved);
      if (name === 'syntaur') return true;
    } catch {
      return basename(entryPath) === 'syntaur';
    }
    return basename(entryPath) === 'syntaur';
  }
  if (!st.isDirectory()) return false;
  const marker = await readInstallMarker(entryPath);
  if (marker?.packageName === 'syntaur') return true;
  const name = await readPluginNameFromManifest(entryPath);
  return name === 'syntaur';
}

async function ownsMarkerlessAgentDir(dir: string): Promise<boolean> {
  if (basename(dir) !== 'syntaur') return false;
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  const entries = await readdir(dir);
  for (const name of entries) {
    if (!name.endsWith('.json') && !name.endsWith('.md')) continue;
    const text = await readText(resolve(dir, name));
    if (text && text.toLowerCase().includes('syntaur')) return true;
  }
  return false;
}

function parseSkillFrontmatter(skillMd: string): { name?: string; author?: string } {
  const match = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const authorMatch = block.match(/^metadata:\s*\n(?:[ \t].*\n)*?[ \t]+author:\s*(.+)$/m)
    ?? block.match(/^metadata\.author:\s*(.+)$/m);
  return {
    name: nameMatch?.[1]?.trim().replace(/^["']|["']$/g, ''),
    author: authorMatch?.[1]?.trim().replace(/^["']|["']$/g, ''),
  };
}

async function ownsRetiredSkillDir(skillDir: string, dirName: string): Promise<boolean> {
  if (!RETIRED_SKILL_SET.has(dirName)) return false;
  if (CURRENT_SKILL_SET.has(dirName as (typeof SYNTAUR_PACK_SKILL_NAMES)[number])) return false;
  const skillMd = await readText(resolve(skillDir, 'SKILL.md'));
  if (!skillMd) return false;
  const fm = parseSkillFrontmatter(skillMd);
  if (fm.name !== dirName) return false;
  if (fm.author === 'prong-horn') return true;
  return skillMd.toLowerCase().includes('syntaur');
}

async function collectClaudePluginDirCandidates(homeDir: string): Promise<string[]> {
  const out = new Set<string>();
  const direct = resolve(homeDir, '.claude/plugins/syntaur');
  out.add(direct);

  const knownPath = resolve(homeDir, '.claude/plugins/known_marketplaces.json');
  if (await fileExists(knownPath)) {
    try {
      const known = JSON.parse(await readFile(knownPath, 'utf-8')) as Record<
        string,
        { installLocation?: string; source?: { path?: string } }
      >;
      for (const value of Object.values(known)) {
        const root =
          value.installLocation ??
          (value.source?.path ? expandHome(value.source.path) : undefined);
        if (root) out.add(resolve(expandHome(root), 'plugins/syntaur'));
      }
    } catch {
      /* ignore */
    }
  }

  const marketplacesDir = resolve(homeDir, '.claude/plugins/marketplaces');
  if (await fileExists(marketplacesDir)) {
    for (const entry of await readdir(marketplacesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      out.add(resolve(marketplacesDir, entry.name, 'plugins/syntaur'));
    }
  }

  return [...out];
}

async function claudeMarketplaceRoots(homeDir: string): Promise<string[]> {
  const roots = new Set<string>();
  const knownPath = resolve(homeDir, '.claude/plugins/known_marketplaces.json');
  if (await fileExists(knownPath)) {
    try {
      const known = JSON.parse(await readFile(knownPath, 'utf-8')) as Record<
        string,
        { installLocation?: string; source?: { path?: string } }
      >;
      for (const value of Object.values(known)) {
        const root =
          value.installLocation ??
          (value.source?.path ? expandHome(value.source.path) : undefined);
        if (root) roots.add(resolve(expandHome(root)));
      }
    } catch {
      /* ignore */
    }
  }
  return [...roots];
}

async function detectClaudePluginLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  const items: Leftover[] = [];
  const home = deps.homeDir;

  for (const dir of await collectClaudePluginDirCandidates(home)) {
    if (!(await fileExists(dir))) continue;
    if (!(await ownsClaudePluginPath(dir))) continue;
    items.push({
      category: 'claude-plugin',
      kind: 'move',
      path: dir,
      detail: 'remove Claude plugin directory',
    });
  }

  const settingsPath = resolve(home, '.claude/settings.json');
  if (await fileExists(settingsPath)) {
    try {
      const settings = await readJsonFile(settingsPath);
      const enabled = settings.enabledPlugins;
      if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) {
        for (const key of Object.keys(enabled as Record<string, unknown>)) {
          if (!isSyntaurPluginKey(key)) continue;
          items.push({
            category: 'claude-plugin',
            kind: 'json-edit',
            path: settingsPath,
            detail: `remove enabledPlugins key ${key}`,
            jsonKey: key,
          });
        }
      }
    } catch {
      items.push({
        category: 'claude-plugin',
        kind: 'blocked',
        path: settingsPath,
        detail: 'unparseable JSON — fix manually',
      });
    }
  }

  const installedPath = resolve(home, '.claude/plugins/installed_plugins.json');
  if (await fileExists(installedPath)) {
    try {
      const raw = await readFile(installedPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const pluginMap =
        parsed.plugins && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins)
          ? (parsed.plugins as Record<string, unknown>)
          : parsed;
      for (const key of Object.keys(pluginMap)) {
        if (!key.startsWith('syntaur@')) continue;
        items.push({
          category: 'claude-plugin',
          kind: 'json-edit',
          path: installedPath,
          detail: `remove installed_plugins entry ${key}`,
          jsonKey: key,
        });
        const marketplace = key.slice('syntaur@'.length);
        const cacheDir = resolve(home, '.claude/plugins/cache', marketplace, 'syntaur');
        if (await fileExists(cacheDir)) {
          items.push({
            category: 'claude-plugin',
            kind: 'move',
            path: cacheDir,
            detail: 'remove plugin cache directory',
          });
        }
      }
    } catch {
      items.push({
        category: 'claude-plugin',
        kind: 'blocked',
        path: installedPath,
        detail: 'unparseable JSON — fix manually',
      });
    }
  }

  for (const root of await claudeMarketplaceRoots(home)) {
    const marketplacePath = resolve(root, '.claude-plugin/marketplace.json');
    if (!(await fileExists(marketplacePath))) continue;
    let raw: string;
    try {
      raw = await readFile(marketplacePath, 'utf-8');
      JSON.parse(raw);
    } catch {
      items.push({
        category: 'claude-plugin',
        kind: 'blocked',
        path: marketplacePath,
        detail: 'unparseable JSON — fix manually',
      });
      continue;
    }
    const file = JSON.parse(raw) as { plugins?: Array<{ name?: string }> };
    for (const entry of file.plugins ?? []) {
      if (entry.name !== 'syntaur') continue;
      items.push({
        category: 'claude-plugin',
        kind: 'json-edit',
        path: marketplacePath,
        detail: 'remove marketplace plugins[] entry syntaur',
        jsonKey: 'syntaur',
      });
    }
  }

  const pluginsDir = resolve(home, '.claude/plugins');
  if (await fileExists(pluginsDir)) {
    for (const name of await readdir(pluginsDir)) {
      if (!name.includes('.bak-')) continue;
      const p = resolve(pluginsDir, name);
      items.push({
        category: 'claude-plugin',
        kind: 'info',
        path: p,
        detail: 'left in place (installer backup)',
      });
    }
  }

  return items;
}

const DEFAULT_AGENTS_MARKETPLACE = {
  name: 'local',
  interface: { displayName: 'Local Plugins' },
  plugins: [] as unknown[],
};

function marketplaceIsDefaultShell(data: Record<string, unknown>): boolean {
  return (
    data.name === DEFAULT_AGENTS_MARKETPLACE.name &&
    (data.interface as { displayName?: string } | undefined)?.displayName ===
      DEFAULT_AGENTS_MARKETPLACE.interface.displayName &&
    Array.isArray(data.plugins) &&
    data.plugins.length === 0
  );
}

async function detectAgentPluginLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  const items: Leftover[] = [];
  const home = deps.homeDir;
  const agentDirs = [
    resolve(home, 'plugins/syntaur'),
    resolve(home, '.codex/plugins/syntaur'),
    resolve(home, '.pi/agent/extensions/syntaur'),
    resolve(home, '.openclaw/extensions/syntaur'),
    resolve(hermesHome(deps), 'plugins/syntaur'),
  ];

  for (const dir of agentDirs) {
    if (!(await fileExists(dir))) continue;
    const owned =
      basename(dir) === 'syntaur' &&
      (dir.includes('extensions') || dir.includes(`${join('plugins', 'syntaur')}`))
        ? (await ownsAgentPluginPath(dir)) || (await ownsMarkerlessAgentDir(dir))
        : await ownsAgentPluginPath(dir);
    if (!owned) continue;
    items.push({
      category: 'agent-plugin',
      kind: 'move',
      path: dir,
      detail: 'remove agent plugin directory',
    });
  }

  const marketplacePath = resolve(home, '.agents/plugins/marketplace.json');
  if (await fileExists(marketplacePath)) {
    let raw: string;
    try {
      raw = await readFile(marketplacePath, 'utf-8');
      JSON.parse(raw);
    } catch {
      items.push({
        category: 'agent-plugin',
        kind: 'blocked',
        path: marketplacePath,
        detail: 'unparseable JSON — fix manually',
      });
      return items;
    }
    const file = JSON.parse(raw) as { plugins?: Array<{ name?: string }> };
    for (const entry of file.plugins ?? []) {
      if (entry.name !== 'syntaur') continue;
      items.push({
        category: 'agent-plugin',
        kind: 'json-edit',
        path: marketplacePath,
        detail: 'remove marketplace plugins[] entry syntaur',
        jsonKey: 'syntaur',
      });
    }
  }

  return items;
}

async function detectSkillLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  const items: Leftover[] = [];
  const roots = [
    resolve(deps.homeDir, '.claude/skills'),
    resolve(deps.homeDir, '.agents/skills'),
    resolve(deps.homeDir, '.codex/skills'),
    resolve(deps.homeDir, '.cursor/skills'),
    resolve(deps.homeDir, '.config/opencode/skills'),
    resolve(deps.homeDir, '.pi/agent/skills'),
    resolve(deps.homeDir, '.openclaw/skills'),
    resolve(hermesHome(deps), 'skills'),
  ];

  const retiringPaths = new Set<string>();

  for (const root of roots) {
    if (!(await fileExists(root))) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!RETIRED_SKILL_SET.has(entry.name)) continue;
      if (CURRENT_SKILL_SET.has(entry.name as (typeof SYNTAUR_PACK_SKILL_NAMES)[number])) continue;
      const full = resolve(root, entry.name);
      let isLink = false;
      try {
        isLink = (await lstat(full)).isSymbolicLink();
      } catch {
        continue;
      }
      if (isLink) {
        let owned = false;
        try {
          const target = await readlink(full);
          const resolved = isAbsolute(target) ? target : resolve(dirname(full), target);
          owned = await ownsRetiredSkillDir(resolved, entry.name);
        } catch {
          owned = true;
        }
        if (!owned) continue;
        items.push({
          category: 'skill',
          kind: 'move',
          path: full,
          detail: 'remove retired skill symlink',
        });
        retiringPaths.add(full);
        continue;
      }
      if (!(await ownsRetiredSkillDir(full, entry.name))) continue;
      items.push({
        category: 'skill',
        kind: 'move',
        path: full,
        detail: 'remove retired skill directory',
      });
      retiringPaths.add(full);
    }
  }

  const lockPath = resolve(deps.homeDir, '.agents/.skill-lock.json');
  if (await fileExists(lockPath)) {
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf-8')) as Record<
        string,
        { source?: string }
      >;
      for (const [name, meta] of Object.entries(lock)) {
        if (!RETIRED_SKILL_SET.has(name)) continue;
        if (meta.source !== 'prong-horn/syntaur') continue;
        items.push({
          category: 'skill',
          kind: 'json-edit',
          path: lockPath,
          detail: `remove skill-lock entry ${name}`,
          jsonKey: name,
        });
      }
    } catch {
      items.push({
        category: 'skill',
        kind: 'blocked',
        path: lockPath,
        detail: 'unparseable JSON — fix manually',
      });
    }
  }

  return items;
}

async function detectLaunchAgentLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  if (deps.platform !== 'darwin') return [];
  const items: Leftover[] = [];
  const launchDir = resolve(deps.homeDir, 'Library/LaunchAgents');
  for (const label of RETIRED_LAUNCH_AGENT_LABELS) {
    const plist = resolve(launchDir, `${label}.plist`);
    if (!(await fileExists(plist))) continue;
    items.push({
      category: 'launch-agent',
      kind: 'move',
      path: plist,
      detail: `bootout and remove LaunchAgent ${label}`,
      launchLabel: label,
    });
  }
  return items;
}

async function urlHandlerOwned(appPath: string): Promise<boolean> {
  const plist = resolve(appPath, 'Contents/Info.plist');
  const text = await readText(plist);
  return Boolean(text && text.includes(URL_HANDLER_BUNDLE_ID));
}

async function detectUrlHandlerLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  if (deps.platform !== 'darwin') return [];
  const items: Leftover[] = [];
  const candidates = [
    resolve(deps.homeDir, 'Library/Application Support/Syntaur/syntaur-url.app'),
    '/Applications/syntaur-url.app',
    resolve(deps.homeDir, 'Applications/syntaur-url.app'),
  ];
  for (const app of candidates) {
    if (!(await fileExists(app))) continue;
    if (!(await urlHandlerOwned(app))) continue;
    if (app.startsWith('/Applications') && !(await isWritable(app))) {
      items.push({
        category: 'url-handler',
        kind: 'blocked',
        path: app,
        detail: 'needs sudo — move by hand after lsregister -u',
      });
      continue;
    }
    items.push({
      category: 'url-handler',
      kind: 'move',
      path: app,
      detail: 'unregister URL handler and move .app bundle',
    });
  }
  return items;
}

async function v2Pending(deps: CleanupDeps): Promise<boolean> {
  const marker = resolve(deps.syntaurHome, V2_MIGRATED_MARKER);
  const completed = await readMarkerSteps(marker);
  return pendingMigrationSteps(completed).length > 0;
}

async function homeEntryKind(
  deps: CleanupDeps,
  absPath: string,
  name: string,
): Promise<LeftoverKind> {
  const rel = relative(deps.syntaurHome, absPath).replace(/\\/g, '/');
  const isProjectAssignments = /^projects\/[^/]+\/assignments$/.test(rel);
  const dataNames = new Set(['missions', 'assignments', 'tickets']);
  if (!dataNames.has(name) && !isProjectAssignments) return 'move';
  if (!(await fileExists(absPath))) return 'move';
  if (await dirIsEmptyOrDsStore(absPath)) return 'move';
  return 'blocked';
}

function homeEntryDetail(name: string, kind: LeftoverKind, pending: boolean): string {
  if (kind === 'move') return `move retired entry ${name}`;
  if (name === 'missions') {
    return 'contains pre-0.2 mission data — inspect and move by hand';
  }
  if (pending) return 'run syntaur migrate v2 --apply first';
  return 'contains data migrate v2 did not convert — inspect and move by hand';
}

async function detectHomeEntryLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  const items: Leftover[] = [];
  const home = deps.syntaurHome;
  const pending = await v2Pending(deps);

  for (const name of RETIRED_HOME_ENTRIES) {
    const abs = resolve(home, name);
    if (name === 'daemon') {
      if (await fileExists(abs)) {
        const kind = (await dirIsEmptyOrDsStore(abs)) ? 'move' : 'move';
        items.push({
          category: 'home-entry',
          kind,
          path: abs,
          detail: `move retired entry ${name}`,
        });
      }
      continue;
    }
    if (name.includes('*')) continue;
    if (name.endsWith('.bak')) continue;
    if (!(await fileExists(abs))) continue;
    let st;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    const kind = st.isDirectory()
      ? await homeEntryKind(deps, abs, name)
      : 'move';
    items.push({
      category: 'home-entry',
      kind,
      path: abs,
      detail: homeEntryDetail(name, kind, pending),
    });
  }

  if (await fileExists(home)) {
    for (const name of await readdir(home)) {
      if (!/^syntaur\.db(\..+\.bak|\.pre-.*\.bak)$/.test(name)) continue;
      items.push({
        category: 'home-entry',
        kind: 'move',
        path: resolve(home, name),
        detail: `move backup ${name}`,
      });
    }
  }

  const runtimeDaemon = resolve(home, 'runtime/daemon');
  if (await fileExists(runtimeDaemon)) {
    items.push({
      category: 'home-entry',
      kind: 'move',
      path: runtimeDaemon,
      detail: 'move runtime/daemon subdirectory',
    });
  }

  const projects = resolve(home, 'projects');
  if (await fileExists(projects)) {
    for (const proj of await readdir(projects, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const todos = resolve(projects, proj.name, 'todos');
      if (await fileExists(todos)) {
        items.push({
          category: 'home-entry',
          kind: 'move',
          path: todos,
          detail: 'move project todos/',
        });
      }
      const assignments = resolve(projects, proj.name, 'assignments');
      if (!(await fileExists(assignments))) continue;
      const kind = (await dirIsEmptyOrDsStore(assignments))
        ? 'move'
        : pending
          ? 'blocked'
          : 'blocked';
      items.push({
        category: 'home-entry',
        kind,
        path: assignments,
        detail: homeEntryDetail('assignments', kind, pending),
      });
    }
  }

  return items;
}

async function detectConfigLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  const configPath = resolve(deps.syntaurHome, 'config.md');
  if (!(await fileExists(configPath))) return [];
  const raw = await readFile(configPath, 'utf-8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fmBlock = fmMatch[1];
  const items: Leftover[] = [];
  for (const key of RETIRED_CONFIG_KEYS) {
    const block = new RegExp(`^${key}:\\s*$`, 'm').test(fmBlock);
    const inline = new RegExp(`^${key}:[ \\t]*\\S`, 'm').test(fmBlock);
    if (!block && !inline) continue;
    items.push({
      category: 'config',
      kind: 'config-edit',
      path: configPath,
      detail: `remove config.md key ${key}`,
      configKey: key,
    });
  }
  return items;
}

async function runtimeOnlySockets(dir: string): Promise<boolean> {
  if (!(await fileExists(dir))) return false;
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 0) return true;
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!(await runtimeOnlySockets(resolve(dir, e.name)))) return false;
      continue;
    }
    if (!e.name.endsWith('.sock') && !e.name.endsWith('.pid')) return false;
  }
  return true;
}

async function detectRuntimeLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  const dir = legacyRuntimeDir(deps);
  if (!(await fileExists(dir))) return [];
  const onlySockets = await runtimeOnlySockets(dir);
  return [
    {
      category: 'runtime',
      kind: onlySockets ? 'delete' : 'move',
      path: dir,
      detail: onlySockets
        ? 'delete legacy daemon runtime (sockets only)'
        : 'move legacy daemon runtime directory',
    },
  ];
}

export async function detectLeftovers(deps: CleanupDeps): Promise<Leftover[]> {
  const parts = await Promise.all([
    detectClaudePluginLeftovers(deps),
    detectAgentPluginLeftovers(deps),
    detectSkillLeftovers(deps),
    detectLaunchAgentLeftovers(deps),
    detectUrlHandlerLeftovers(deps),
    detectHomeEntryLeftovers(deps),
    detectConfigLeftovers(deps),
    detectRuntimeLeftovers(deps),
  ]);
  return parts.flat();
}

interface ManifestEntry {
  category: LeftoverCategory;
  action: LeftoverKind;
  original: string;
  retired?: string;
  removed?: string;
  command?: { cmd: string; args: string[]; status: number | null };
}

interface Manifest {
  createdAt: string;
  syntaurVersion: string;
  entries: ManifestEntry[];
}

async function appendManifest(manifestPath: string, manifest: Manifest): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

async function moveToRetired(
  homeDir: string,
  retiredDir: string,
  sourcePath: string,
): Promise<string> {
  const rel = retiredRelativePath(homeDir, sourcePath);
  const dest = resolve(retiredDir, rel);
  await ensureDir(dirname(dest));
  try {
    await rename(sourcePath, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyTree(sourcePath, dest);
    await rm(sourcePath, { recursive: true, force: true });
  }
  return dest;
}

async function copyTree(src: string, dest: string): Promise<void> {
  await ensureDir(dirname(dest));
  const st = await lstat(src);
  if (st.isDirectory()) {
    await ensureDir(dest);
    for (const entry of await readdir(src, { withFileTypes: true })) {
      await copyTree(resolve(src, entry.name), resolve(dest, entry.name));
    }
    return;
  }
  await copyFile(src, dest);
}

async function backupEditedFile(
  homeDir: string,
  retiredDir: string,
  filePath: string,
): Promise<string> {
  const rel = retiredRelativePath(homeDir, filePath);
  const dest = resolve(retiredDir, '_edited', rel);
  await ensureDir(dirname(dest));
  await copyFile(filePath, dest);
  return dest;
}

function removeMarketplacePluginEntry(raw: string, pluginName: string): string {
  const data = JSON.parse(raw) as {
    plugins?: Array<{ name?: string; [key: string]: unknown }>;
  };
  data.plugins = (data.plugins ?? []).filter((p) => p.name !== pluginName);
  return JSON.stringify(data, null, 2) + '\n';
}

function removeInstalledPluginEntry(raw: string, key: string): string {
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data.plugins && typeof data.plugins === 'object' && !Array.isArray(data.plugins)) {
    delete (data.plugins as Record<string, unknown>)[key];
    return JSON.stringify(data, null, 2) + '\n';
  }
  delete data[key];
  return JSON.stringify(data, null, 2) + '\n';
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export async function applyCleanup(
  leftovers: Leftover[],
  deps: CleanupDeps,
  retiredDir: string,
): Promise<CleanupResult> {
  const manifestPath = resolve(retiredDir, 'manifest.json');
  const syntaurVersion = (await readPackageVersion(import.meta.url)) ?? '0.0.0';
  const manifest: Manifest = {
    createdAt: deps.now().toISOString(),
    syntaurVersion,
    entries: [],
  };
  await ensureDir(retiredDir);
  await appendManifest(manifestPath, manifest);

  let moved = 0;
  let edited = 0;
  let deleted = 0;
  let blocked = 0;

  for (const item of leftovers) {
    if (item.kind === 'info') continue;
    if (item.kind === 'blocked') {
      blocked += 1;
      continue;
    }

    if (item.category === 'launch-agent' && item.kind === 'move' && item.launchLabel) {
      const cmd = 'launchctl';
      const args = ['bootout', `gui/${deps.uid}/${item.launchLabel}`];
      const result = deps.runner(cmd, args);
      await moveToRetired(deps.homeDir, retiredDir, item.path);
      manifest.entries.push({
        category: item.category,
        action: item.kind,
        original: item.path,
        retired: resolve(retiredDir, retiredRelativePath(deps.homeDir, item.path)),
        command: { cmd, args, status: result.status },
      });
      moved += 1;
      await appendManifest(manifestPath, manifest);
      continue;
    }

    if (item.category === 'url-handler' && item.kind === 'move') {
      const cmd = LSREGISTER;
      const args = ['-u', item.path];
      deps.runner(cmd, args);
      const retired = await moveToRetired(deps.homeDir, retiredDir, item.path);
      manifest.entries.push({
        category: item.category,
        action: item.kind,
        original: item.path,
        retired,
        command: { cmd, args, status: 0 },
      });
      moved += 1;
      await appendManifest(manifestPath, manifest);
      continue;
    }

    if (item.kind === 'delete') {
      await rm(item.path, { recursive: true, force: true });
      manifest.entries.push({
        category: item.category,
        action: item.kind,
        original: item.path,
      });
      deleted += 1;
      await appendManifest(manifestPath, manifest);
      continue;
    }

    if (item.kind === 'move') {
      const retired = await moveToRetired(deps.homeDir, retiredDir, item.path);
      manifest.entries.push({
        category: item.category,
        action: item.kind,
        original: item.path,
        retired,
      });
      moved += 1;
      await appendManifest(manifestPath, manifest);
      continue;
    }

    if (item.kind === 'json-edit') {
      const raw = await readFile(item.path, 'utf-8');
      if (item.path.endsWith('marketplace.json')) {
        const nextRaw = removeMarketplacePluginEntry(raw, item.jsonKey ?? 'syntaur');
        const parsed = JSON.parse(nextRaw) as Record<string, unknown>;
        const agentsMarketplace = item.path.endsWith('.agents/plugins/marketplace.json');
        if (agentsMarketplace && marketplaceIsDefaultShell(parsed)) {
          await backupEditedFile(deps.homeDir, retiredDir, item.path);
          const retired = await moveToRetired(deps.homeDir, retiredDir, item.path);
          manifest.entries.push({
            category: item.category,
            action: 'move',
            original: item.path,
            retired,
            removed: item.jsonKey,
          });
          moved += 1;
          await appendManifest(manifestPath, manifest);
          continue;
        }
        await backupEditedFile(deps.homeDir, retiredDir, item.path);
        await writeFileForce(item.path, nextRaw);
        manifest.entries.push({
          category: item.category,
          action: item.kind,
          original: item.path,
          removed: item.jsonKey,
        });
        edited += 1;
        await appendManifest(manifestPath, manifest);
        continue;
      }

      await backupEditedFile(deps.homeDir, retiredDir, item.path);
      let next = raw;
      if (item.path.endsWith('settings.json') && item.jsonKey) {
        const data = JSON.parse(raw) as Record<string, unknown>;
        const enabled = data.enabledPlugins as Record<string, unknown> | undefined;
        if (enabled && item.jsonKey in enabled) {
          delete enabled[item.jsonKey];
          data.enabledPlugins = enabled;
        }
        next = JSON.stringify(data, null, 2) + '\n';
      } else if (item.path.endsWith('installed_plugins.json') && item.jsonKey) {
        next = removeInstalledPluginEntry(raw, item.jsonKey);
      } else if (item.path.endsWith('.skill-lock.json') && item.jsonKey) {
        const data = JSON.parse(raw) as Record<string, unknown>;
        delete data[item.jsonKey];
        next = JSON.stringify(data, null, 2) + '\n';
      }
      await writeFileForce(item.path, next);
      manifest.entries.push({
        category: item.category,
        action: item.kind,
        original: item.path,
        removed: item.jsonKey,
      });
      edited += 1;
      await appendManifest(manifestPath, manifest);
      continue;
    }

    if (item.kind === 'config-edit') {
      await backupEditedFile(deps.homeDir, retiredDir, item.path);
      const raw = await readFile(item.path, 'utf-8');
      const { content } = removeRetiredConfigKeys(raw);
      await writeFileForce(item.path, content);
      manifest.entries.push({
        category: item.category,
        action: item.kind,
        original: item.path,
        removed: item.configKey,
      });
      edited += 1;
      await appendManifest(manifestPath, manifest);
    }
  }

  return { moved, edited, deleted, blocked, retiredDir };
}

function formatLeftoverLine(mode: string, item: Leftover): string {
  return `${mode}${item.path}: ${item.detail} (${item.kind})`;
}

export interface MigrateCleanupOptions {
  apply?: boolean;
  root?: string;
}

export async function runMigrateCleanup(
  options: MigrateCleanupOptions,
  deps: CleanupDeps = defaultCleanupDeps(),
): Promise<{ lines: string[] }> {
  if (options.root) {
    process.env.SYNTAUR_HOME = resolve(expandHome(options.root));
  }
  const resolvedDeps: CleanupDeps = {
    ...deps,
    syntaurHome: options.root ? syntaurRoot() : deps.syntaurHome,
  };
  const mode = options.apply ? '[apply] ' : '[dry-run] ';
  const lines: string[] = [];
  const leftovers = await detectLeftovers(resolvedDeps);
  const applyable = leftovers.filter((l) => !['info', 'blocked'].includes(l.kind));
  const blockedCount = leftovers.filter((l) => l.kind === 'blocked').length;

  if (leftovers.length === 0) {
    lines.push('No pre-v2 leftovers found.');
    return { lines };
  }

  const byCategory = new Map<LeftoverCategory, Leftover[]>();
  for (const item of leftovers) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  for (const category of CATEGORY_ORDER) {
    const group = byCategory.get(category);
    if (!group?.length) continue;
    lines.push(`${mode}${categoryHeader(category)}:`);
    for (const item of group) {
      lines.push(formatLeftoverLine(mode, item));
    }
  }

  const moveCount = leftovers.filter((l) => l.kind === 'move').length;
  const editCount = leftovers.filter(
    (l) => l.kind === 'json-edit' || l.kind === 'config-edit',
  ).length;
  const deleteCount = leftovers.filter((l) => l.kind === 'delete').length;
  const total = moveCount + editCount + deleteCount + blockedCount;

  if (!options.apply) {
    lines.push(
      `${total} leftovers: ${moveCount} moved, ${editCount} edited, ${deleteCount} deleted, ${blockedCount} blocked`,
    );
    return { lines };
  }

  if (applyable.length === 0) {
    lines.push(`${total} leftovers: 0 moved, 0 edited, 0 deleted, ${blockedCount} blocked`);
    return { lines };
  }

  const ts = resolvedDeps.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const retiredDir = resolve(resolvedDeps.homeDir, `.syntaur-retired-${ts}`);
  const result = await applyCleanup(leftovers, resolvedDeps, retiredDir);
  lines.push(
    `${result.moved + result.edited + result.deleted + result.blocked} leftovers: ${result.moved} moved, ${result.edited} edited, ${result.deleted} deleted, ${result.blocked} blocked`,
  );
  lines.push(`Retired to ${retiredDir} (see manifest.json)`);
  return { lines };
}

export const cleanupMigrateCommand = new Command('cleanup')
  .description('Detect and retire pre-v2 install leftovers (dry-run by default)')
  .option('--apply', 'Apply retirement moves and edits')
  .option('--root <path>', 'Syntaur home for ~/.syntaur checks (default ~/.syntaur)')
  .action(async (opts: { apply?: boolean; root?: string }) => {
    try {
      const { lines } = await runMigrateCleanup({ apply: opts.apply, root: opts.root });
      for (const line of lines) console.log(line);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
