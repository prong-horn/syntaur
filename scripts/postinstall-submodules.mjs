#!/usr/bin/env node
// Lazy-init git submodules for contributor clones.
// Silent no-op for end-user installs (where .git/.gitmodules are absent
// because npm publish bundles the vendored files directly).

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const gitDir = resolve(repoRoot, '.git');
const gitmodules = resolve(repoRoot, '.gitmodules');
const vendoredSkills = resolve(repoRoot, 'vendor', 'syntaur-skills', 'skills');

// End-user install (from npm): no .git, no .gitmodules. Nothing to do.
if (!existsSync(gitDir) || !existsSync(gitmodules)) {
  process.exit(0);
}

// Contributor already initialized submodules.
if (existsSync(vendoredSkills)) {
  process.exit(0);
}

const result = spawnSync(
  'git',
  ['submodule', 'update', '--init', '--recursive'],
  { cwd: repoRoot, stdio: 'inherit' },
);

if (result.status !== 0) {
  console.warn(
    '[postinstall-submodules] git submodule update failed — ' +
      'run it manually before building.',
  );
  // Do not fail postinstall; let the build step surface the missing files.
}
