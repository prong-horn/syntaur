import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  getTerminal,
  TERMINAL_CHOICES,
  type TerminalChoice,
} from '../../config.js';
import {
  APP_BUNDLE_IDS,
  CLI_NAMES,
  probeTerminalInstalled,
} from '../../terminal-probe.js';
import { syntaurRoot } from '../../paths.js';
import { fileExists } from '../../fs.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'terminal';

/**
 * Read the raw `terminal:` line from `~/.syntaur/config.md` frontmatter.
 *
 * `readConfig()` already coerces invalid values to `null` and emits a warning,
 * so by the time `ctx.config.terminal` reaches a doctor check the bad value is
 * gone. To actually detect a misconfiguration we have to parse the raw file.
 *
 * Returns:
 *   - `null` when the file is missing or no `terminal:` line is present
 *   - a string (possibly invalid) when a `terminal:` line was found
 */
async function readRawTerminalKey(): Promise<string | null> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) return null;
  const content = await readFile(configPath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const line = fmMatch[1]
    .split('\n')
    .find((l) => /^terminal:\s*/.test(l));
  if (!line) return null;
  const raw = line.replace(/^terminal:\s*/, '').trim();
  if (raw.length === 0) return null;
  // Strip surrounding YAML quotes so `terminal: "ghostty"` and `terminal: 'ghostty'`
  // round-trip identically to the unquoted form. parseFrontmatter handles this
  // for readConfig; the raw-file reader has to handle it too.
  const unquoted = /^"(.*)"$|^'(.*)'$/.exec(raw);
  return unquoted ? (unquoted[1] ?? unquoted[2]) : raw;
}

const terminalValueValid: Check = {
  id: 'terminal.value-valid',
  category: CATEGORY,
  title: 'Configured terminal value is recognized',
  async run(ctx) {
    const raw = await readRawTerminalKey();
    if (raw === null) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        detail: `not set in config.md — defaulting to ${getTerminal(ctx.config)}`,
        autoFixable: false,
      };
    }
    if (!TERMINAL_CHOICES.includes(raw as TerminalChoice)) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'warn',
        detail: `unknown terminal "${raw}" in ~/.syntaur/config.md`,
        remediation: {
          kind: 'manual',
          suggestion: `Set \`terminal:\` in ~/.syntaur/config.md to one of: ${TERMINAL_CHOICES.join(', ')}`,
          command: null,
        },
        autoFixable: false,
      };
    }
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'pass',
      detail: `terminal: ${raw}`,
      autoFixable: false,
    };
  },
};

const terminalInstalled: Check = {
  id: 'terminal.installed',
  category: CATEGORY,
  title: 'Configured terminal is installed',
  async run(ctx) {
    const terminal = getTerminal(ctx.config);
    const bundleId = APP_BUNDLE_IDS[terminal];
    const cliName = CLI_NAMES[terminal];
    const probe = probeTerminalInstalled(terminal);

    if (probe.reason === 'no-probe-available') {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: `no install check defined for ${terminal}`,
        autoFixable: false,
      };
    }

    if (probe.ok) {
      const detail = bundleId
        ? `found ${terminal} at ${probe.foundPath}`
        : `resolved ${cliName} → ${probe.foundPath}`;
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        detail,
        autoFixable: false,
      };
    }

    const detail = bundleId
      ? `${terminal} (bundle id ${bundleId}) not found via Spotlight or in /Applications`
      : `${cliName} not found on PATH`;
    const suggestion = bundleId
      ? `Install ${terminal} or change \`terminal:\` in ~/.syntaur/config.md to a different choice`
      : `Install ${cliName} or change \`terminal:\` in ~/.syntaur/config.md to a different choice`;
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail,
      remediation: {
        kind: 'manual',
        suggestion,
        command: null,
      },
      autoFixable: false,
    };
  },
};

const kittyRemoteControl: Check = {
  id: 'terminal.kitty-remote-control',
  category: CATEGORY,
  title: 'kitty remote-control is enabled (optional)',
  async run(ctx): Promise<CheckResult | CheckResult[]> {
    if (getTerminal(ctx.config) !== 'kitty') {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'skipped',
        detail: 'terminal is not kitty',
        autoFixable: false,
      };
    }

    const result = spawnSync('kitty', ['@', 'ls'], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (result.status === 0) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'pass',
        detail: 'kitty @ ls succeeded — remote control is available',
        autoFixable: false,
      };
    }
    return {
      id: this.id,
      category: this.category,
      title: this.title,
      status: 'warn',
      detail:
        'kitty @ ls did not succeed — the fallback `kitty --directory` path will be used. Add `allow_remote_control yes` to ~/.config/kitty/kitty.conf for the preferred `kitty @ launch` path.',
      remediation: {
        kind: 'manual',
        suggestion:
          'Add `allow_remote_control yes` to ~/.config/kitty/kitty.conf and restart kitty',
        command: null,
      },
      autoFixable: false,
    };
  },
};

export const terminalChecks: Check[] = [
  terminalValueValid,
  terminalInstalled,
  kittyRemoteControl,
];
