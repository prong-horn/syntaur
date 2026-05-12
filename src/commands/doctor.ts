import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { runChecks } from '../utils/doctor/index.js';
import { renderHuman } from '../utils/doctor/output-human.js';
import { renderJson } from '../utils/doctor/output-json.js';
import { fileExists } from '../utils/fs.js';
import { syntaurRoot } from '../utils/paths.js';
import { parseAssignmentFrontmatter } from '../lifecycle/frontmatter.js';

interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  only?: string;
  verbose?: boolean;
  assignment?: string;
}

interface AssignmentValidationResult {
  ok: boolean;
  path: string;
  errors: string[];
  warnings: string[];
}

const REQUIRED_WORKSPACE_FIELDS = [
  'repository',
  'worktreePath',
  'branch',
  'parentBranch',
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export async function validateAssignmentFile(
  inputPath: string,
  cwd: string = process.cwd(),
): Promise<AssignmentValidationResult> {
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!(await fileExists(absolute))) {
    return {
      ok: false,
      path: absolute,
      errors: [`File does not exist: ${absolute}`],
      warnings: [],
    };
  }
  let content: string;
  try {
    content = await readFile(absolute, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      path: absolute,
      errors: [
        `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
      ],
      warnings: [],
    };
  }
  if (!content.startsWith('---')) {
    errors.push('Missing YAML frontmatter — file does not start with `---`.');
  }
  let parsed: ReturnType<typeof parseAssignmentFrontmatter>;
  try {
    parsed = parseAssignmentFrontmatter(content);
  } catch (err) {
    errors.push(
      `Frontmatter parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, path: absolute, errors, warnings };
  }
  if (!parsed.id) errors.push('Missing or empty `id` field.');
  if (!parsed.slug) errors.push('Missing or empty `slug` field.');
  if (!parsed.title) errors.push('Missing or empty `title` field.');
  if (!parsed.status) errors.push('Missing or empty `status` field.');
  if (!parsed.created) errors.push('Missing or empty `created` field.');
  else if (!ISO_DATE.test(parsed.created))
    warnings.push(`Field \`created\` is not ISO 8601: "${parsed.created}".`);
  if (!parsed.updated) errors.push('Missing or empty `updated` field.');
  else if (!ISO_DATE.test(parsed.updated))
    warnings.push(`Field \`updated\` is not ISO 8601: "${parsed.updated}".`);
  // Workspace block: parseWorkspace fills nulls for absent fields, so we have
  // to check the raw frontmatter source for actual key presence.
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fmText = fmMatch ? fmMatch[1] : '';
  for (const key of REQUIRED_WORKSPACE_FIELDS) {
    if (!new RegExp(`^\\s+${key}:`, 'm').test(fmText)) {
      errors.push(`Workspace block is missing required field \`${key}\`.`);
    }
  }
  return { ok: errors.length === 0, path: absolute, errors, warnings };
}

export const doctorCommand = new Command('doctor')
  .description('Diagnose Syntaur state and surface issues with suggested fixes')
  .option('--json', 'Emit structured JSON for programmatic consumers')
  .option('--fix', 'Apply safe auto-fixes (v1: no-op; reserved for future checks)')
  .option('--only <check-id>', 'Run only the check with this ID')
  .option('--verbose', 'Include passing checks in human output')
  .option(
    '--assignment <path>',
    'Validate a single assignment.md frontmatter and exit (used by set-workspace skill pre-write)',
  )
  .action(async (options: DoctorOptions) => {
    if (options.assignment) {
      const result = await validateAssignmentFile(options.assignment);
      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.ok) {
        process.stdout.write(`OK ${result.path}\n`);
        for (const w of result.warnings) process.stdout.write(`  warn: ${w}\n`);
      } else {
        process.stderr.write(`FAIL ${result.path}\n`);
        for (const e of result.errors) process.stderr.write(`  error: ${e}\n`);
        for (const w of result.warnings) process.stderr.write(`  warn: ${w}\n`);
      }
      process.exit(result.ok ? 0 : 1);
    }

    if (!(await fileExists(syntaurRoot()))) {
      const msg = '~/.syntaur/ does not exist. Run `syntaur init` first.';
      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            {
              version: '1.0',
              error: msg,
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(msg + '\n');
      }
      process.exit(2);
    }

    try {
      const report = await runChecks({ only: options.only });

      if (options.json) {
        process.stdout.write(renderJson(report) + '\n');
      } else {
        process.stdout.write(renderHuman(report, { verbose: options.verbose ?? false }) + '\n');
      }

      if (options.fix && !options.json) {
        process.stdout.write(
          '\nnote: --fix is reserved but has no auto-fixable remediations in v1.\n',
        );
      }

      const hasError = report.summary.error > 0;
      process.exit(hasError ? 1 : 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (options.json) {
        process.stdout.write(JSON.stringify({ version: '1.0', error: msg }, null, 2) + '\n');
      } else {
        process.stderr.write(`doctor itself failed: ${msg}\n`);
      }
      process.exit(2);
    }
  });
