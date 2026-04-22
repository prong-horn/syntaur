#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, '..', 'vendor', 'syntaur-skills', 'skills');

if (!existsSync(skillsDir)) {
  console.error(`
[verify-vendored-skills] Missing vendored skills at:
  ${skillsDir}

This usually means the git submodule was not initialized. Run:

  git submodule update --init --recursive

`);
  process.exit(1);
}

const required = [
  'syntaur-protocol',
  'grab-assignment',
  'plan-assignment',
  'complete-assignment',
  'create-assignment',
  'create-project',
];

const present = new Set(readdirSync(skillsDir));
const missing = required.filter((name) => !present.has(name));

if (missing.length > 0) {
  console.error(
    `[verify-vendored-skills] Missing skills: ${missing.join(', ')}\n` +
      `Expected under ${skillsDir}.`,
  );
  process.exit(1);
}

console.error(`[verify-vendored-skills] ok — ${required.length} skills present`);
