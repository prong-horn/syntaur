#!/usr/bin/env node
// Generate a spec-valid Agent Skills v0.2.0 discovery index from the canonical
// `skills/` tree:  <out-dir>/index.json  +  the artifacts it references.
//
//   index.json   { "$schema": "...0.2.0/schema.json", "skills": [ {name,type,description,url,digest}, ... ] }
//
// Each entry's `url` is **index-directory-relative** (`<name>/SKILL.md` or
// `<name>.tar.gz`, no leading slash) so it resolves correctly whether the index
// is hosted at an origin root (custom domain / org Pages) OR under a GitHub
// project-Pages subpath (`/<repo>/`) — skills.sh resolves `new URL(entry.url,
// indexUrl)` (base = the index URL), so a leading-slash url would re-root to the
// origin and 404 under a subpath.
//
// Single-file skills → `type: "skill-md"` (url → the copied SKILL.md, digest =
// sha256 of its bytes). Multi-file skills (only `syntaur-protocol` today, which
// bundles `references/`) → `type: "archive"`: a **deterministic** POSIX ustar
// tar.gz with a root SKILL.md (digest = sha256 of the archive bytes).
//
// Dependency-free + deterministic on any platform (Node >= 20): no `tar`, no
// YAML lib. Frontmatter is parsed inline (handles folded `>-` / literal `|`
// block scalars). NOT shared with `src/` — see the Phase-2 decision record.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCHEMA_URI = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Spec digest form: `sha256:<64 lowercase hex>`. */
export function digestOf(buf) {
  return `sha256:${sha256Hex(buf)}`;
}

// ---------------------------------------------------------------------------
// Frontmatter (name + description) — inline, dependency-free
// ---------------------------------------------------------------------------

function stripQuotes(s) {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;

/**
 * Parse `name` and `description` from a SKILL.md. Operates on raw indented
 * lines — never splits a body line on `:` (descriptions contain colons, e.g.
 * `bundle b:xxxx`). A block scalar body is the run of lines whose indent is
 * strictly greater than the `description:` key's indent; it terminates at the
 * first non-blank line whose indent <= the key indent (always `license:` here).
 */
export function parseSkillFrontmatter(skillMdText) {
  const m = skillMdText.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('No `---` frontmatter block found.');
  const lines = m[1].split('\n');

  let name = null;
  let description = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyIndent = indentOf(line);
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch && keyIndent === 0) {
      name = stripQuotes(nameMatch[1]);
      continue;
    }
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch && keyIndent === 0) {
      const rest = descMatch[1].trim();
      const blockIndicator = rest.match(/^([|>])([+-]?)\s*$/);
      if (rest && !blockIndicator) {
        // inline scalar
        description = stripQuotes(rest);
        continue;
      }
      // block scalar: gather body lines
      const folded = !blockIndicator || blockIndicator[1] === '>';
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const bl = lines[j];
        if (bl.trim() === '') {
          body.push('');
          continue;
        }
        if (indentOf(bl) <= keyIndent) break;
        body.push(bl);
      }
      i = j - 1;
      // trim leading/trailing blank lines
      while (body.length && body[0] === '') body.shift();
      while (body.length && body[body.length - 1] === '') body.pop();
      const baseIndent = body
        .filter((l) => l !== '')
        .reduce((min, l) => Math.min(min, indentOf(l)), Infinity);
      const dedented = body.map((l) => (l === '' ? '' : l.slice(baseIndent)));
      if (folded) {
        let out = '';
        for (const l of dedented) {
          if (l === '') out += '\n';
          else out += (out && !out.endsWith('\n') ? ' ' : '') + l;
        }
        description = out.replace(/\n{2,}/g, '\n').trim();
      } else {
        description = dedented.join('\n').trim();
      }
      continue;
    }
  }

  if (!name) throw new Error('Missing or empty `name` in frontmatter.');
  if (!description) throw new Error(`Missing or empty \`description\` for "${name}".`);
  return { name, description };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function pathExists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/** Immediate subdirs of `skillsDir` that contain a SKILL.md, sorted. */
export async function listSkillDirs(skillsDir) {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (await pathExists(join(skillsDir, e.name, 'SKILL.md'))) dirs.push(e.name);
  }
  dirs.sort();
  return dirs;
}

/** Recursively list files under `root`, as POSIX-relative paths, sorted. */
async function listFilesRel(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await listFilesRel(root, rel)));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic POSIX ustar tar.gz
// ---------------------------------------------------------------------------

function writeOctal(buf, value, off, len) {
  // (len-1) zero-padded octal digits + NUL terminator.
  const s = value.toString(8).padStart(len - 1, '0') + '\0';
  buf.write(s, off, 'binary');
}

function ustarHeader(name, size) {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, 100, 'utf8'); // name        @0   /100
  writeOctal(buf, 0o644, 100, 8); //  mode        @100 /8
  writeOctal(buf, 0, 108, 8); //       uid         @108 /8
  writeOctal(buf, 0, 116, 8); //       gid         @116 /8
  writeOctal(buf, size, 124, 12); //   size        @124 /12
  writeOctal(buf, 0, 136, 12); //      mtime       @136 /12
  buf.fill(0x20, 148, 156); //         chksum      @148 /8  (spaces while summing)
  buf.write('0', 156, 'binary'); //    typeflag    @156 /1  '0' = regular file
  buf.write('ustar\0', 257, 'binary'); // magic    @257 /6
  buf.write('00', 263, 'binary'); //   version     @263 /2
  // uname/gname/dev/prefix left zero.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  const chk = (sum & 0o777777).toString(8).padStart(6, '0');
  buf.write(`${chk}\0 `, 148, 'binary'); // 6 octal digits + NUL + space
  return buf;
}

/**
 * Build a deterministic tar.gz of every file under `rootDir` (paths relative to
 * `rootDir`, so `SKILL.md` is at the archive root). Fixed mtime/uid/gid/mode,
 * sorted entries; gzip header MTIME zeroed (Node already does) and OS byte set
 * to 0xFF for cross-toolchain byte-stability. Byte-identical on repeat runs.
 */
export async function buildDeterministicTarGz(rootDir) {
  const files = await listFilesRel(rootDir);
  const blocks = [];
  for (const rel of files) {
    const content = await readFile(join(rootDir, rel));
    blocks.push(ustarHeader(rel, content.length));
    blocks.push(content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two zero blocks = end of archive
  const tar = Buffer.concat(blocks);
  const gz = gzipSync(tar, { level: 9 });
  gz[4] = gz[5] = gz[6] = gz[7] = 0; // MTIME (defensive; Node already zeroes)
  gz[9] = 0xff; // OS = unknown (do NOT touch offset 8/XFL or 10)
  return gz;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate `<outDir>/index.json` + artifacts from `skillsDir`.
 * Returns `{ index, summary }`.
 */
export async function buildSkillsIndex({ skillsDir, outDir }) {
  await mkdir(outDir, { recursive: true });
  const dirNames = await listSkillDirs(skillsDir);
  const skills = [];
  let skillMdCount = 0;
  let archiveCount = 0;

  for (const dirName of dirNames) {
    const skillDir = join(skillsDir, dirName);
    const files = await listFilesRel(skillDir);
    const skillMdBytes = await readFile(join(skillDir, 'SKILL.md'));
    const { name, description } = parseSkillFrontmatter(skillMdBytes.toString('utf8'));
    if (name !== dirName) {
      throw new Error(`skill "${dirName}": frontmatter name "${name}" must match the directory name.`);
    }

    let type, url, digest;
    if (files.length === 1 && files[0] === 'SKILL.md') {
      type = 'skill-md';
      url = `${name}/SKILL.md`;
      digest = digestOf(skillMdBytes);
      await mkdir(join(outDir, name), { recursive: true });
      await writeFile(join(outDir, name, 'SKILL.md'), skillMdBytes);
      skillMdCount++;
    } else {
      type = 'archive';
      const tgz = await buildDeterministicTarGz(skillDir);
      url = `${name}.tar.gz`;
      digest = digestOf(tgz);
      await writeFile(join(outDir, `${name}.tar.gz`), tgz);
      archiveCount++;
    }

    skills.push({ name, type, description, url, digest });
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const index = { $schema: SCHEMA_URI, skills };
  await writeFile(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  return {
    index,
    summary: { total: skills.length, skillMd: skillMdCount, archive: archiveCount },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skills-dir') out.skillsDir = argv[++i];
    else if (argv[i] === '--out-dir') out.outDir = argv[++i];
  }
  return out;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const args = parseArgs(process.argv.slice(2));
  const skillsDir = resolve(args.skillsDir ?? join(repoRoot, 'skills'));
  const outDir = resolve(args.outDir ?? join(repoRoot, '.well-known', 'agent-skills'));

  const { summary } = await buildSkillsIndex({ skillsDir, outDir });
  console.error(
    `[build-skills-index] ${summary.total} skills → ${summary.skillMd} skill-md, ${summary.archive} archive  (${outDir}/index.json)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[build-skills-index] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
