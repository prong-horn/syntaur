import { readFile, readdir, stat, mkdir, copyFile, rm } from 'node:fs/promises';
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
  status: 'installed' | 'already-current' | 'differs-preserved' | 'overwritten';
  targetPath: string;
}

const REQUIRED_SKILLS = [
  'syntaur-protocol',
  'grab-assignment',
  'plan-assignment',
  'complete-assignment',
  'create-assignment',
  'create-project',
] as const;

export function getVendoredSkillsDir(): string {
  // After tsup bundling, import.meta.url resolves to <pkg>/dist/index.js.
  // Vendored skills live at <pkg>/vendor/syntaur-skills/skills/.
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up once from `dist` to the package root.
  return resolve(here, '..', 'vendor', 'syntaur-skills', 'skills');
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

export async function installSkills(
  options: InstallSkillsOptions,
): Promise<SkillInstallResult[]> {
  const source = options.sourceDir ?? getVendoredSkillsDir();
  const targetRoot = options.targetDir ?? defaultSkillTargetDir(options.target);
  const force = options.force ?? false;

  if (!(await fileExists(source))) {
    throw new Error(
      `Vendored skills not found at ${source}. Reinstall syntaur: npm install -g syntaur@latest`,
    );
  }

  const results: SkillInstallResult[] = [];
  await mkdir(targetRoot, { recursive: true });

  for (const skill of REQUIRED_SKILLS) {
    const srcDir = join(source, skill);
    const destDir = join(targetRoot, skill);

    if (!(await fileExists(srcDir))) continue;

    if (!(await fileExists(destDir))) {
      await copyDir(srcDir, destDir);
      results.push({
        skill,
        status: 'installed',
        targetPath: destDir,
      });
      continue;
    }

    if (await skillMatches(srcDir, destDir)) {
      results.push({
        skill,
        status: 'already-current',
        targetPath: destDir,
      });
      continue;
    }

    if (force) {
      await rm(destDir, { recursive: true, force: true });
      await copyDir(srcDir, destDir);
      results.push({
        skill,
        status: 'overwritten',
        targetPath: destDir,
      });
    } else {
      results.push({
        skill,
        status: 'differs-preserved',
        targetPath: destDir,
      });
    }
  }

  return results;
}

export async function uninstallSkills(options: {
  target: SkillTarget;
  targetDir?: string;
}): Promise<string[]> {
  const targetRoot =
    options.targetDir ?? defaultSkillTargetDir(options.target);
  if (!(await fileExists(targetRoot))) return [];

  const removed: string[] = [];
  for (const skill of REQUIRED_SKILLS) {
    const destDir = join(targetRoot, skill);
    if (!(await fileExists(destDir))) continue;

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
      '  Run with --force-skills to overwrite with the vendored version.',
    );
  }
  return lines.join('\n');
}

export const KNOWN_SKILLS = REQUIRED_SKILLS;
