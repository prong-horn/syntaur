import { Command } from 'commander';
import { resolve } from 'node:path';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { syntaurRoot } from '../utils/paths.js';
import { ensureDir, fileExists } from '../utils/fs.js';
import {
  BUILTIN_TEMPLATE_IDS,
  builtinStatus,
  builtinTemplatesDir,
  resetBuiltin,
  resetMissingBuiltins,
  type BuiltinTemplateId,
} from '../ticket-templates/builtins.js';
import { listTemplates, validateTemplateDir } from '../ticket-templates/registry.js';

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

export const templateCommand = new Command('template').description(
  'Manage ticket templates — manifests, built-ins, and validation',
);

templateCommand
  .command('list')
  .description('List installed templates')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const root = syntaurRoot();
    const templates = await listTemplates(root);
    const rows = templates.map((t) => ({
      id: t.id,
      description: t.description,
      stamp: t.builtin ?? null,
      driftStatus: t.driftStatus ?? null,
      stageIds: t.stageIds,
      fileCount: t.filePaths.length,
    }));
    if (opts.json) {
      console.log(JSON.stringify({ templates: rows }, null, 2));
      return;
    }
    for (const r of rows) {
      const drift = r.driftStatus ? ` [${r.driftStatus}]` : '';
      const stamp = r.stamp ? ` (${r.stamp})` : '';
      console.log(
        `${r.id.padEnd(12)} ${r.description}${stamp}${drift}  (${r.fileCount} files, stages: ${r.stageIds.join(', ')})`,
      );
    }
  });

templateCommand
  .command('new')
  .description('Create a custom template from a built-in')
  .argument('<id>', 'New template id')
  .requiredOption('--from <builtin>', 'Built-in template to copy from')
  .action(async (id: string, opts: { from: string }) => {
    if (!(BUILTIN_TEMPLATE_IDS as readonly string[]).includes(opts.from)) {
      return fail(`unknown built-in "${opts.from}"`);
    }
    const root = syntaurRoot();
    const targetDir = resolve(root, 'templates', id);
    if (await fileExists(targetDir)) {
      return fail(`template "${id}" already exists`);
    }

    let sourceDir = resolve(root, 'templates', opts.from);
    if (!(await fileExists(sourceDir))) {
      sourceDir = resolve(builtinTemplatesDir(), opts.from);
    }
    if (!(await fileExists(sourceDir))) {
      return fail(`built-in "${opts.from}" is not installed — run syntaur init or template reset --missing`);
    }

    await cp(sourceDir, targetDir, { recursive: true });

    const manifestPath = resolve(targetDir, 'template.md');
    let content = await readFile(manifestPath, 'utf-8');
    content = content.replace(/^id:\s*.+$/m, `id: ${id}`);
    content = content.replace(/^builtin:\s*.+\n/m, '');
    await writeFile(manifestPath, content, 'utf-8');

    console.log(`Created template "${id}" from "${opts.from}".`);
  });

templateCommand
  .command('check')
  .description('Validate template manifests')
  .argument('[id]', 'Template id (omit to check all)')
  .option('--builtins', 'Report built-in drift status')
  .option('--json', 'Output as JSON')
  .action(async (id: string | undefined, opts: { builtins?: boolean; json?: boolean }) => {
    const root = syntaurRoot();
    let hasIssues = false;

    if (opts.builtins) {
      const rows = [];
      for (const bid of BUILTIN_TEMPLATE_IDS) {
        const status = await builtinStatus(root, bid);
        rows.push({ id: bid, status });
        if (status !== 'current' && status !== 'missing') hasIssues = true;
        if (status === 'missing') hasIssues = true;
      }
      if (opts.json) {
        console.log(JSON.stringify({ builtins: rows }, null, 2));
      } else {
        for (const r of rows) {
          console.log(`${r.id}: ${r.status}`);
        }
      }
    }

    const ids: string[] = [];
    if (id) {
      ids.push(id);
    } else if (!opts.builtins || id === undefined) {
      const templates = await listTemplates(root);
      ids.push(...templates.map((t) => t.id));
    }

    const results = [];
    for (const tid of ids) {
      const dir = resolve(root, 'templates', tid);
      if (!(await fileExists(resolve(dir, 'template.md')))) {
        hasIssues = true;
        const row = { id: tid, issues: [{ rule: 'missing', message: 'template.md not found' }] };
        results.push(row);
        if (!opts.json) console.error(`${tid}: template.md not found`);
        continue;
      }
      const { issues } = await validateTemplateDir(root, tid);
      if (issues.length > 0) hasIssues = true;
      results.push({ id: tid, issues });
      if (!opts.json) {
        for (const issue of issues) {
          console.error(`${tid}: rule ${issue.rule}: ${issue.message}`);
        }
      }
    }

    if (opts.json && results.length > 0) {
      console.log(JSON.stringify({ templates: results }, null, 2));
    }

    if (hasIssues) process.exitCode = 1;
  });

templateCommand
  .command('reset')
  .description('Restore built-in templates from the package')
  .argument('[id]', 'Built-in template id')
  .option('--missing', 'Seed only absent built-ins')
  .action(async (id: string | undefined, opts: { missing?: boolean }) => {
    const root = syntaurRoot();
    await ensureDir(resolve(root, 'templates'));

    const missingOnly = opts.missing || id === '--missing';
    if (missingOnly) {
      const seeded = await resetMissingBuiltins(root);
      if (seeded.length === 0) {
        console.log('All built-in templates present.');
      } else {
        console.log(`Seeded built-in templates: ${seeded.join(', ')}`);
      }
      return;
    }

    if (!id) {
      return fail('pass a built-in id or use --missing');
    }
    if (!(BUILTIN_TEMPLATE_IDS as readonly string[]).includes(id)) {
      return fail(`"${id}" is not a built-in template id`);
    }

    await resetBuiltin(root, id as BuiltinTemplateId);
    console.log(`Reset built-in template "${id}".`);
  });
