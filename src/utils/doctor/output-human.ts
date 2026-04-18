import type { CheckResult, DoctorReport } from './types.js';

const USE_COLOR = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
};

function c(code: string, text: string): string {
  return USE_COLOR ? `${code}${text}${COLOR.reset}` : text;
}

const STATUS_BADGE: Record<CheckResult['status'], string> = {
  pass: c(COLOR.green, 'PASS '),
  warn: c(COLOR.yellow, 'WARN '),
  error: c(COLOR.red, 'ERROR'),
  skipped: c(COLOR.gray, 'SKIP '),
};

export interface HumanRenderOptions {
  verbose: boolean;
}

export function renderHuman(report: DoctorReport, options: HumanRenderOptions = { verbose: false }): string {
  const lines: string[] = [];
  lines.push(
    c(COLOR.bold, 'syntaur doctor') +
      c(COLOR.dim, `  (syntaur ${report.syntaurVersion}, ran ${report.ranAt})`),
  );
  lines.push('');

  const byCategory = new Map<string, CheckResult[]>();
  for (const check of report.checks) {
    const list = byCategory.get(check.category) ?? [];
    list.push(check);
    byCategory.set(check.category, list);
  }

  for (const [category, checks] of byCategory) {
    const visible = options.verbose ? checks : checks.filter((c) => c.status !== 'pass');
    if (visible.length === 0) {
      lines.push(c(COLOR.dim, `[${category}] all passed`));
      continue;
    }
    lines.push(c(COLOR.bold, `[${category}]`));
    for (const check of visible) {
      lines.push(`  ${STATUS_BADGE[check.status]}  ${c(COLOR.cyan, check.id)}  ${check.title}`);
      if (check.detail) lines.push(`         ${c(COLOR.dim, check.detail)}`);
      if (check.affected && check.affected.length > 0) {
        for (const path of check.affected.slice(0, 3)) {
          lines.push(`         ${c(COLOR.gray, '→ ' + path)}`);
        }
        if (check.affected.length > 3) {
          lines.push(`         ${c(COLOR.gray, `  …and ${check.affected.length - 3} more`)}`);
        }
      }
      if (check.remediation && check.remediation.suggestion) {
        lines.push(`         ${c(COLOR.dim, 'fix: ' + check.remediation.suggestion)}`);
        if (check.remediation.command) {
          lines.push(`         ${c(COLOR.cyan, '$ ' + check.remediation.command)}`);
        }
      }
    }
    lines.push('');
  }

  const s = report.summary;
  lines.push(
    c(COLOR.bold, 'summary: ') +
      `${c(COLOR.green, s.pass + ' passed')}, ` +
      `${c(COLOR.yellow, s.warn + ' warnings')}, ` +
      `${c(COLOR.red, s.error + ' errors')}, ` +
      `${c(COLOR.gray, s.skipped + ' skipped')}`,
  );
  return lines.join('\n');
}
