#!/usr/bin/env node
// Stamp the plugin manifests' `version` from package.json.version.
//
// There are THREE tracked, version-bearing plugin manifests. They were
// hand-frozen at 0.8.0, decoupled from the package version — which is why
// Claude Code pinned the installed plugin (its marketplace entry copies the
// manifest version, so a never-changing version = never-updates). This script
// keeps all three in lockstep with package.json so every release advertises a
// real, monotonic version.
//
//   .claude-plugin/plugin.json                      (repo-root manifest)
//   platforms/claude-code/.claude-plugin/plugin.json (the install SOURCE — load-bearing)
//   platforms/codex/.codex-plugin/plugin.json        (native consistency)
//
// Usage:
//   node scripts/sync-plugin-version.mjs           # rewrite all three to package.json.version
//   node scripts/sync-plugin-version.mjs --check    # exit 1 if any manifest drifts (CI gate)
//
// Wired into the npm `version` lifecycle (stamps + git-adds the manifests into
// the release commit) and `prepack` (tarball safety net). NOTE: under
// `npm version --no-git-tag-version` the script still runs and stages the
// manifests, but no commit is created — they are left staged. That is benign.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The three tracked manifests, relative to repoRoot. */
export const PLUGIN_MANIFESTS = [
  '.claude-plugin/plugin.json',
  'platforms/claude-code/.claude-plugin/plugin.json',
  'platforms/codex/.codex-plugin/plugin.json',
];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Stamp (or check) every plugin manifest's `version` against package.json.
 *
 * @param {{ repoRoot: string, check?: boolean }} opts
 * @returns {Promise<{ version: string, changed: string[], drifted: string[] }>}
 */
export async function syncPluginVersion({ repoRoot, check = false }) {
  const pkg = await readJson(resolve(repoRoot, 'package.json'));
  const version = pkg.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`package.json at ${repoRoot} has no usable "version"`);
  }

  const changed = [];
  const drifted = [];
  for (const rel of PLUGIN_MANIFESTS) {
    const path = resolve(repoRoot, rel);
    const manifest = await readJson(path);
    if (manifest.version === version) continue;
    if (check) {
      drifted.push(rel);
      continue;
    }
    // Mutate only `version`; preserve all other fields + their order.
    manifest.version = version;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    changed.push(rel);
  }
  return { version, changed, drifted };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const check = process.argv.slice(2).includes('--check');
  const { version, changed, drifted } = await syncPluginVersion({ repoRoot, check });

  if (check) {
    if (drifted.length > 0) {
      console.error(
        `[sync-plugin-version] DRIFT: ${drifted.join(', ')} != package.json version ${version}. ` +
          `Run \`node scripts/sync-plugin-version.mjs\` and commit.`,
      );
      process.exit(1);
    }
    console.error(`[sync-plugin-version] ok — all manifests match ${version}`);
    return;
  }

  if (changed.length > 0) {
    console.error(`[sync-plugin-version] stamped ${version} into: ${changed.join(', ')}`);
  } else {
    console.error(`[sync-plugin-version] already in sync at ${version}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[sync-plugin-version] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
