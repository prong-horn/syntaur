import { readFile, readdir, mkdir, copyFile, rm, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { fileExists } from './fs.js';

export type SkillTarget = 'claude' | 'codex';

export interface InstallSkillsOptions {
  target: SkillTarget;
  force?: boolean;
  targetDir?: string; // override for tests
  sourceDir?: string; // override for tests
}

export interface SkillInstallResult {
  skill: string;
  status:
    | 'installed'
    | 'already-current'
    | 'differs-preserved'
    | 'overwritten'
    | 'skipped-symlink';
  targetPath: string;
}

// Skills the syntaur CLI considers first-class. Discovery is dynamic — every
// directory under <pkg>/skills/ that contains a SKILL.md is installed — but
// this list pins the install order and provides a stable source-of-truth for
// uninstallSkills() and the doctor command. Update when a skill is added or
// retired.
const KNOWN_SKILL_NAMES = [
  'syntaur-protocol',
  'grab-assignment',
  'plan-assignment',
  'complete-assignment',
  'create-assignment',
  'create-project',
  'manage-statuses',
  'clear-assignment',
  'track-session',
  'track-server',
] as const;

export const KNOWN_SKILLS = KNOWN_SKILL_NAMES;

export function getSkillsDir(): string {
  // After tsup bundling, import.meta.url resolves to <pkg>/dist/index.js.
  // Skills live at <pkg>/skills/. Walk up once from `dist` to the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'skills');
}

export function defaultSkillTargetDir(target: SkillTarget): string {
  if (target === 'claude') return resolve(homedir(), '.claude', 'skills');
  return resolve(homedir(), '.codex', 'skills');
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}

async function filesEqual(a: string, b: string): Promise<boolean> {
  try {
    const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
    if (ba.length !== bb.length) return false;
    return ba.equals(bb);
  } catch {
    return false;
  }
}

async function copyDir(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dest);
    } else if (entry.isFile()) {
      await copyFile(src, dest);
    }
  }
}

async function skillMatches(srcDir: string, destDir: string): Promise<boolean> {
  if (!(await fileExists(destDir))) return false;
  const srcFiles = await walkFiles(srcDir);
  for (const srcFile of srcFiles) {
    const rel = relative(srcDir, srcFile);
    const destFile = join(destDir, rel);
    if (!(await filesEqual(srcFile, destFile))) return false;
  }
  // Also ensure dest has no extra files that would make it "different".
  const destFiles = await walkFiles(destDir);
  if (destFiles.length !== srcFiles.length) return false;
  return true;
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function installSkillDir(
  srcDir: string,
  destDir: string,
  skillName: string,
  force: boolean,
): Promise<SkillInstallResult> {
  // Skills.sh CLI default-installs by symlinking. If the target is a symlink,
  // assume the skills.sh CLI (or the user) is managing this skill and don't
  // overwrite it.
  if (await isSymlink(destDir)) {
    return {
      skill: skillName,
      status: 'skipped-symlink',
      targetPath: destDir,
    };
  }

  if (!(await fileExists(destDir))) {
    await copyDir(srcDir, destDir);
    return { skill: skillName, status: 'installed', targetPath: destDir };
  }

  if (await skillMatches(srcDir, destDir)) {
    return { skill: skillName, status: 'already-current', targetPath: destDir };
  }

  if (force) {
    await rm(destDir, { recursive: true, force: true });
    await copyDir(srcDir, destDir);
    return { skill: skillName, status: 'overwritten', targetPath: destDir };
  }

  return { skill: skillName, status: 'differs-preserved', targetPath: destDir };
}

async function discoverSkillNames(sourceDir: string): Promise<string[]> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (await fileExists(join(sourceDir, entry.name, 'SKILL.md'))) {
      names.push(entry.name);
    }
  }
  // Order: pinned names first (in their declared order), then any extra
  // skills sorted alphabetically.
  const pinnedSet = new Set<string>(KNOWN_SKILL_NAMES);
  const pinned: string[] = KNOWN_SKILL_NAMES.filter((name) => names.includes(name));
  const extras = names.filter((name) => !pinnedSet.has(name)).sort();
  return [...pinned, ...extras];
}

export async function installSkills(
  options: InstallSkillsOptions,
): Promise<SkillInstallResult[]> {
  const source = options.sourceDir ?? getSkillsDir();
  const targetRoot = options.targetDir ?? defaultSkillTargetDir(options.target);
  const force = options.force ?? false;

  if (!(await fileExists(source))) {
    throw new Error(
      `Syntaur skills not found at ${source}. Reinstall syntaur: npm install -g syntaur@latest`,
    );
  }

  const skillNames = await discoverSkillNames(source);
  const results: SkillInstallResult[] = [];
  await mkdir(targetRoot, { recursive: true });

  for (const skill of skillNames) {
    const srcDir = join(source, skill);
    const destDir = join(targetRoot, skill);
    results.push(await installSkillDir(srcDir, destDir, skill, force));
  }

  return results;
}

export async function uninstallSkills(options: {
  target: SkillTarget;
  targetDir?: string;
  sourceDir?: string;
}): Promise<string[]> {
  const targetRoot =
    options.targetDir ?? defaultSkillTargetDir(options.target);
  if (!(await fileExists(targetRoot))) return [];

  const sourceDir = options.sourceDir ?? getSkillsDir();
  const known = new Set<string>();
  if (await fileExists(sourceDir)) {
    for (const name of await discoverSkillNames(sourceDir)) {
      known.add(name);
    }
  } else {
    for (const name of KNOWN_SKILL_NAMES) {
      known.add(name);
    }
  }

  const removed: string[] = [];
  for (const skill of known) {
    const destDir = join(targetRoot, skill);
    if (!(await fileExists(destDir))) continue;

    // Skills.sh manages symlinks; never remove them.
    if (await isSymlink(destDir)) continue;

    // Safety: only remove if SKILL.md frontmatter `name:` matches the
    // known skill name — never delete a user-authored skill that happens
    // to share a directory name.
    const skillMd = join(destDir, 'SKILL.md');
    if (!(await fileExists(skillMd))) continue;

    const content = await readFile(skillMd, 'utf-8').catch(() => '');
    const match = content.match(/^name:\s*(\S+)\s*$/m);
    if (!match || match[1] !== skill) continue;

    await rm(destDir, { recursive: true, force: true });
    removed.push(destDir);
  }
  return removed;
}

export function formatInstallReport(
  results: SkillInstallResult[],
  target: SkillTarget,
): string {
  const lines: string[] = [];
  lines.push(`Skill install (${target}):`);
  for (const r of results) {
    const marker =
      r.status === 'installed'
        ? '+'
        : r.status === 'overwritten'
          ? '!'
          : r.status === 'differs-preserved'
            ? '?'
            : r.status === 'skipped-symlink'
              ? '~'
              : '=';
    lines.push(`  ${marker} ${r.skill} (${r.status})`);
  }
  const diffs = results.filter((r) => r.status === 'differs-preserved');
  if (diffs.length > 0) {
    lines.push('');
    lines.push(
      `  Note: ${diffs.length} skill(s) already exist with different content and were preserved.`,
    );
    lines.push(
      '  Run with --force-skills to overwrite with the syntaur version.',
    );
  }
  const symlinked = results.filter((r) => r.status === 'skipped-symlink');
  if (symlinked.length > 0) {
    lines.push('');
    lines.push(
      `  Note: ${symlinked.length} skill(s) were skipped because the target is a symlink (likely managed by skills.sh).`,
    );
  }
  return lines.join('\n');
}
