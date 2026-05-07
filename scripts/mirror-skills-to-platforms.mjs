#!/usr/bin/env node
// Mirror <repo>/skills/ into each platforms/<kind>/skills/ so the plugin
// manifests' `./skills/<name>` paths resolve when the plugin is enabled.
//
// The canonical source is <repo>/skills/. The platform-side dirs are a
// build artifact (.gitignored). Run before npm pack/publish and on
// initial dev setup so syntaur install-plugin --link finds skills.

import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const skillsSource = resolve(repoRoot, 'skills');

if (!existsSync(skillsSource)) {
  console.error(`[mirror-skills] No skills/ at ${skillsSource} — nothing to mirror.`);
  process.exit(0);
}

const platforms = ['claude-code', 'codex'];
for (const platform of platforms) {
  const dest = resolve(repoRoot, 'platforms', platform, 'skills');
  if (!existsSync(resolve(repoRoot, 'platforms', platform))) {
    continue;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(skillsSource, dest, { recursive: true });
  console.error(`[mirror-skills] mirrored skills/ → platforms/${platform}/skills/`);
}
