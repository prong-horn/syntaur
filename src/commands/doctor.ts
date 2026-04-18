import { Command } from 'commander';
import { runChecks } from '../utils/doctor/index.js';
import { renderHuman } from '../utils/doctor/output-human.js';
import { renderJson } from '../utils/doctor/output-json.js';
import { fileExists } from '../utils/fs.js';
import { syntaurRoot } from '../utils/paths.js';

interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  only?: string;
  verbose?: boolean;
}

export const doctorCommand = new Command('doctor')
  .description('Diagnose Syntaur state and surface issues with suggested fixes')
  .option('--json', 'Emit structured JSON for programmatic consumers')
  .option('--fix', 'Apply safe auto-fixes (v1: no-op; reserved for future checks)')
  .option('--only <check-id>', 'Run only the check with this ID')
  .option('--verbose', 'Include passing checks in human output')
  .action(async (options: DoctorOptions) => {
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
