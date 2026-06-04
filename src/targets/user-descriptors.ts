// Loader + validator for user-authored agent target descriptors.
//
// Users register arbitrary agents (Tier 1 + Tier 2) without a Syntaur release by
// dropping a JSON file in `~/.syntaur/targets/`. This module reads those files,
// validates them against the `UserAgentDescriptor` schema (hand-written — the repo
// ships no JSON-schema validator), compiles the declarative `DetectSpec` into a
// runtime probe, and returns ready-to-merge `AgentTarget`s. It NEVER throws — a bad
// file degrades to a warning so one typo can't break `setup`/`doctor` for everyone.
//
// See references/user-targets.md for the documented schema.

import { resolve } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileExists } from '../utils/fs.js';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { RENDERERS } from './renderers.js';
import type {
  AgentSkillsDir,
  AgentTarget,
  DetectSpec,
  UserAgentDescriptor,
} from './types.js';

/** The directory user descriptors live in: `~/.syntaur/targets` (honors `$SYNTAUR_HOME`). */
export function userTargetsDir(): string {
  return resolve(syntaurRoot(), 'targets');
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const VALID_RENDERER_KEYS: ReadonlySet<string> = new Set(Object.keys(RENDERERS));
const ALLOWED_TOP_KEYS: ReadonlySet<string> = new Set([
  'id',
  'displayName',
  'skillsShAgentId',
  'detect',
  'skillsDir',
  'instructions',
]);

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Expand a leading `~` and any `$VAR` / `${VAR}` from the environment, then absolutize. */
export function expandHomeAndEnv(p: string): string {
  const envExpanded = p.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      const v = process.env[name];
      return v ?? '';
    },
  );
  return resolve(expandHome(envExpanded));
}

/** Compile a declarative `DetectSpec` into the `AgentTarget['detect']` probe. */
export function compileDetect(spec: DetectSpec): () => Promise<boolean> {
  switch (spec.kind) {
    case 'pathExists': {
      const p = expandHomeAndEnv(spec.path);
      return () => fileExists(p);
    }
    case 'anyPathExists': {
      const ps = spec.paths.map(expandHomeAndEnv);
      return async () => {
        for (const p of ps) {
          if (await fileExists(p)) return true;
        }
        return false;
      };
    }
    case 'envSet': {
      const env = spec.env;
      return async () => {
        const v = process.env[env];
        return typeof v === 'string' && v.length > 0;
      };
    }
  }
}

export type ValidateResult =
  | { ok: true; value: UserAgentDescriptor }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateDetect(detect: unknown, errors: string[]): void {
  if (!isPlainObject(detect)) {
    errors.push('detect must be an object');
    return;
  }
  switch (detect.kind) {
    case 'pathExists':
      if (typeof detect.path !== 'string' || detect.path.length === 0)
        errors.push('detect.path must be a non-empty string for kind "pathExists"');
      break;
    case 'anyPathExists':
      if (
        !Array.isArray(detect.paths) ||
        detect.paths.length === 0 ||
        !detect.paths.every((p) => typeof p === 'string' && p.length > 0)
      )
        errors.push('detect.paths must be a non-empty string[] for kind "anyPathExists"');
      break;
    case 'envSet':
      if (typeof detect.env !== 'string' || detect.env.length === 0)
        errors.push('detect.env must be a non-empty string for kind "envSet"');
      break;
    default:
      errors.push(
        `detect.kind must be one of pathExists|anyPathExists|envSet (got ${JSON.stringify(detect.kind)})`,
      );
  }
}

function validateInstructions(instructions: unknown, errors: string[]): void {
  if (!isPlainObject(instructions)) {
    errors.push('instructions must be an object');
    return;
  }
  if (!Array.isArray(instructions.files) || instructions.files.length === 0) {
    errors.push('instructions.files must be a non-empty array');
    return;
  }
  instructions.files.forEach((f, i) => {
    if (!isPlainObject(f)) {
      errors.push(`instructions.files[${i}] must be an object`);
      return;
    }
    if (typeof f.path !== 'string' || f.path.length === 0)
      errors.push(`instructions.files[${i}].path must be a non-empty string`);
    if (typeof f.renderer !== 'string' || !VALID_RENDERER_KEYS.has(f.renderer))
      errors.push(
        `instructions.files[${i}].renderer ${JSON.stringify(f.renderer)} is not a known renderer ` +
          `(valid: ${[...VALID_RENDERER_KEYS].join(', ')})`,
      );
  });
}

/**
 * Validate a parsed JSON value against the `UserAgentDescriptor` schema. Collects
 * ALL errors (does not bail on the first). `builtinIds` are rejected — user
 * descriptors may only add NEW agent ids, never override a built-in.
 */
export function validateUserDescriptor(
  data: unknown,
  builtinIds: ReadonlySet<string>,
): ValidateResult {
  const errors: string[] = [];
  if (!isPlainObject(data)) {
    return { ok: false, errors: ['descriptor must be a JSON object'] };
  }

  for (const k of Object.keys(data)) {
    if (!ALLOWED_TOP_KEYS.has(k)) errors.push(`unknown field "${k}"`);
  }

  if (typeof data.id !== 'string' || data.id.length === 0) {
    errors.push('id is required and must be a non-empty string');
  } else if (!ID_RE.test(data.id)) {
    errors.push(`id "${data.id}" must match ${ID_RE.source}`);
  } else if (builtinIds.has(data.id)) {
    errors.push(
      `id "${data.id}" collides with a built-in agent (built-ins cannot be overridden)`,
    );
  }

  if (typeof data.displayName !== 'string' || data.displayName.trim().length === 0) {
    errors.push('displayName is required and must be a non-empty string');
  }

  if (
    data.skillsShAgentId !== undefined &&
    (typeof data.skillsShAgentId !== 'string' || data.skillsShAgentId.length === 0)
  ) {
    errors.push('skillsShAgentId must be a non-empty string when present');
  }

  if (data.detect === undefined) {
    errors.push('detect is required');
  } else {
    validateDetect(data.detect, errors);
  }

  if (data.skillsDir !== undefined) {
    if (!isPlainObject(data.skillsDir)) {
      errors.push('skillsDir must be an object');
    } else {
      for (const k of Object.keys(data.skillsDir)) {
        if (k !== 'project' && k !== 'global') errors.push(`skillsDir.${k} is not a valid key`);
      }
      if (data.skillsDir.project !== undefined && typeof data.skillsDir.project !== 'string')
        errors.push('skillsDir.project must be a string');
      if (data.skillsDir.global !== undefined && typeof data.skillsDir.global !== 'string')
        errors.push('skillsDir.global must be a string');
    }
  }

  if (data.instructions !== undefined) {
    validateInstructions(data.instructions, errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: data as unknown as UserAgentDescriptor };
}

/** Compile a validated descriptor into a runtime `AgentTarget`. */
export function compileDescriptor(desc: UserAgentDescriptor): AgentTarget {
  const target: AgentTarget = {
    id: desc.id,
    displayName: desc.displayName,
    detect: compileDetect(desc.detect),
  };
  if (desc.skillsShAgentId) target.skillsShAgentId = desc.skillsShAgentId;
  if (desc.skillsDir) {
    const skillsDir: AgentSkillsDir = {};
    // `global` feeds the offline-copy fallback's `installSkillsToDir`, which needs
    // an ABSOLUTE path — expand it. `project` is project-relative by design.
    if (desc.skillsDir.global) skillsDir.global = expandHomeAndEnv(desc.skillsDir.global);
    if (desc.skillsDir.project) skillsDir.project = desc.skillsDir.project;
    target.skillsDir = skillsDir;
  }
  if (desc.instructions) target.instructions = desc.instructions;
  return target;
}

export interface LoadUserDescriptorsOptions {
  /** Override the descriptor dir (defaults to `userTargetsDir()`). */
  dir?: string;
  /** Built-in ids that user descriptors may not override. */
  builtinIds?: ReadonlySet<string>;
}

/**
 * Read every `*.json` in the user-targets dir, validate, and return the compiled
 * targets plus any warnings (bad files are skipped, not thrown). Deterministic
 * (files sorted); first occurrence of a duplicate id wins.
 */
export async function loadUserDescriptors(
  opts: LoadUserDescriptorsOptions = {},
): Promise<{ targets: AgentTarget[]; warnings: string[] }> {
  const dir = opts.dir ?? userTargetsDir();
  const builtinIds = opts.builtinIds ?? new Set<string>();
  const warnings: string[] = [];

  if (!(await fileExists(dir))) return { targets: [], warnings };

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    return { targets: [], warnings: [`could not read ${dir}: ${msg(err)}`] };
  }

  const targets: AgentTarget[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const full = resolve(dir, file);
    let raw: string;
    try {
      raw = await readFile(full, 'utf-8');
    } catch (err) {
      warnings.push(`skipped ${file}: ${msg(err)}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warnings.push(`skipped ${file}: invalid JSON: ${msg(err)}`);
      continue;
    }
    const result = validateUserDescriptor(parsed, builtinIds);
    if (!result.ok) {
      warnings.push(`skipped ${file}: ${result.errors.join('; ')}`);
      continue;
    }
    if (seen.has(result.value.id)) {
      warnings.push(
        `skipped ${file}: duplicate id "${result.value.id}" (already loaded from an earlier file)`,
      );
      continue;
    }
    seen.add(result.value.id);
    targets.push(compileDescriptor(result.value));
  }

  return { targets, warnings };
}
