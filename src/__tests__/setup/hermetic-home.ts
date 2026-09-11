/**
 * Redirect HOME to a throwaway directory for every test file.
 *
 * Prevents tests from leaking into the real ~/.syntaur: recordEvent() lazy-opens
 * ~/.syntaur/syntaur.db, and the Hermes plugin appends to
 * ~/.syntaur/tier3-violations.log when spawned with inherited env.
 */
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const homeDir = mkdtempSync(join(tmpdir(), 'syntaur-test-home-'));
process.env.HOME = homeDir;
delete process.env.SYNTAUR_HOME;

process.env.GIT_AUTHOR_NAME = 'Syntaur Tests';
process.env.GIT_AUTHOR_EMAIL = 'tests@syntaur.invalid';
process.env.GIT_COMMITTER_NAME = 'Syntaur Tests';
process.env.GIT_COMMITTER_EMAIL = 'tests@syntaur.invalid';

afterAll(() => {
  rmSync(homeDir, { recursive: true, force: true });
});
