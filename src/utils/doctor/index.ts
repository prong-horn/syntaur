import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildCheckContext, closeCheckContext } from './context.js';
import { allChecks } from './registry.js';
import type { Check, CheckContext, CheckResult, DoctorReport } from './types.js';

export interface RunOptions {
  only?: string;
  cwd?: string;
}

export async function runChecks(options: RunOptions = {}): Promise<DoctorReport> {
  const ctx = await buildCheckContext(options.cwd);
  try {
    return await runWithContext(ctx, options);
  } finally {
    closeCheckContext(ctx);
  }
}

export async function runWithContext(
  ctx: CheckContext,
  options: RunOptions = {},
): Promise<DoctorReport> {
  const checks = filterChecks(allChecks(), options.only);
  const results: CheckResult[] = [];

  const rootCheck = checks.find((c) => c.id === 'env.syntaur-root-exists');
  if (rootCheck) {
    const res = await safeRun(rootCheck, ctx);
    results.push(...res);
    const rootPassed = res.every((r) => r.status !== 'error');
    if (!rootPassed) {
      for (const c of checks) {
        if (c.id === rootCheck.id) continue;
        results.push(skipped(c, 'skipped: ~/.syntaur/ not initialized'));
      }
      return finalize(results);
    }
  }

  for (const check of checks) {
    if (check.id === 'env.syntaur-root-exists') continue;
    const res = await safeRun(check, ctx);
    results.push(...res);
  }

  return finalize(results);
}

function filterChecks(checks: Check[], only: string | undefined): Check[] {
  if (!only) return checks;
  return checks.filter((c) => c.id === only);
}

async function safeRun(check: Check, ctx: CheckContext): Promise<CheckResult[]> {
  try {
    const res = await check.run(ctx);
    return Array.isArray(res) ? res : [res];
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return [
      {
        id: check.id,
        category: check.category,
        title: check.title,
        status: 'error',
        detail: `check threw: ${detail}`,
        autoFixable: false,
      },
    ];
  }
}

function skipped(check: Check, reason: string): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'skipped',
    detail: reason,
    autoFixable: false,
  };
}

async function finalize(checks: CheckResult[]): Promise<DoctorReport> {
  const summary = { pass: 0, warn: 0, error: 0, skipped: 0 };
  for (const c of checks) summary[c.status]++;
  const version = (await readVersion()) ?? '0.0.0';
  return {
    version: '1.0',
    syntaurVersion: version,
    ranAt: new Date().toISOString(),
    summary,
    checks,
  };
}

async function readVersion(): Promise<string | null> {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = dirname(here);
    for (let i = 0; i < 6; i++) {
      try {
        const raw = await readFile(join(dir, 'package.json'), 'utf-8');
        const parsed = JSON.parse(raw) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : null;
      } catch {
        dir = dirname(dir);
      }
    }
    return null;
  } catch {
    return null;
  }
}
