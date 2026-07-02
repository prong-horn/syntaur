import { Command } from 'commander';
import { resolve } from 'node:path';
import { readConfig, type StatusConfig } from '../utils/config.js';
import { buildDefaultStatusConfig } from '../utils/status-defaults.js';
import { getWorkflowLibrary, DEFAULT_WORKFLOW_ID } from '../utils/workflow-resolve.js';
import {
  writeWorkflowBundle,
  deleteWorkflowFromConfig,
  setDefaultWorkflow,
} from '../utils/workflow-write.js';
import { scanWorkflowUsage } from '../utils/status-config-resolution.js';
import { makeWorkflowContextResolver } from '../lifecycle/workflow-context.js';
import { readProjectBinding, setProjectWorkflowBinding } from '../utils/project-binding.js';
import { defaultProjectDir, assignmentsDir } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';

/** Workflow ids must be keyword-safe slugs so they round-trip through config.md
 * frontmatter keys, route params, and AQL without quoting. */
function isValidWorkflowId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(id) && id.length <= 64;
}

/** Strip a WorkflowDefinition down to the writable status bundle. */
function toBundle(wf: StatusConfig): StatusConfig {
  return {
    statuses: wf.statuses,
    order: wf.order,
    transitions: wf.transitions,
    derive: wf.derive,
    facts: wf.facts,
  };
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

export const workflowCommand = new Command('workflow').description(
  'Manage lifecycle workflows — named status bundles a ticket can be bound to',
);

workflowCommand
  .command('list')
  .description('List the defined workflows and the global default')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const config = await readConfig();
    const library = getWorkflowLibrary(config);
    const def = config.defaultWorkflow ?? DEFAULT_WORKFLOW_ID;
    const rows = Object.entries(library).map(([id, wf]) => ({
      id,
      label: wf.label,
      isDefault: id === def,
      custom: !!config.workflows && id in config.workflows,
      statusCount: wf.statuses.length,
    }));
    if (opts.json) {
      console.log(JSON.stringify({ workflows: rows, defaultWorkflow: def }, null, 2));
      return;
    }
    for (const r of rows) {
      const marker = r.isDefault ? '*' : ' ';
      console.log(`${marker} ${r.id.padEnd(20)} ${r.label}  (${r.statusCount} statuses)`);
    }
    console.log(`\nDefault workflow: ${def}`);
  });

workflowCommand
  .command('new')
  .description('Create a new workflow (built-in status set, or cloned from another)')
  .argument('<id>', 'Workflow id (letters, digits, "_" or "-")')
  .option('--label <label>', 'Display label (defaults to Title Case of the id)')
  .option('--from <sourceId>', 'Clone the status bundle from an existing workflow')
  .option('--set-default', 'Also make this the global default workflow')
  .action(
    async (id: string, opts: { label?: string; from?: string; setDefault?: boolean }) => {
      if (!isValidWorkflowId(id)) return fail(`invalid workflow id "${id}"`);
      const config = await readConfig();
      const library = getWorkflowLibrary(config);
      if (library[id]) return fail(`workflow "${id}" already exists`);

      let bundle: StatusConfig;
      if (opts.from) {
        const source = library[opts.from];
        if (!source) return fail(`unknown source workflow "${opts.from}"`);
        bundle = toBundle(source);
      } else {
        bundle = buildDefaultStatusConfig();
      }
      await writeWorkflowBundle(id, bundle, { label: opts.label, setDefault: opts.setDefault });
      console.log(
        `Created workflow "${id}"${opts.from ? ` from "${opts.from}"` : ''}${
          opts.setDefault ? ' (now the default)' : ''
        }.`,
      );
    },
  );

workflowCommand
  .command('edit')
  .description('Edit a workflow’s display label')
  .argument('<id>', 'Workflow id')
  .option('--label <label>', 'New display label')
  .action(async (id: string, opts: { label?: string }) => {
    const config = await readConfig();
    const library = getWorkflowLibrary(config);
    const wf = library[id];
    if (!wf) return fail(`unknown workflow "${id}"`);
    if (opts.label === undefined) return fail('nothing to edit — pass --label');
    await writeWorkflowBundle(id, toBundle(wf), { label: opts.label });
    console.log(`Updated workflow "${id}".`);
  });

workflowCommand
  .command('delete')
  .description('Delete a workflow (blocked while any project or ticket references it)')
  .argument('<id>', 'Workflow id')
  .action(async (id: string) => {
    if (id === DEFAULT_WORKFLOW_ID) return fail('the built-in "default" workflow cannot be deleted');
    const config = await readConfig();
    const library = getWorkflowLibrary(config);
    if (!library[id]) return fail(`unknown workflow "${id}"`);

    const usage = await scanWorkflowUsage(id, {
      resolver: makeWorkflowContextResolver(config),
      isGlobalDefault: config.defaultWorkflow === id,
      projectsDir: defaultProjectDir(),
      standaloneDir: assignmentsDir(),
    });
    if (!usage.deletable) {
      console.error(`cannot delete workflow "${id}":`);
      for (const b of usage.blockers) console.error(`  - ${b}`);
      process.exitCode = 1;
      return;
    }
    await deleteWorkflowFromConfig(id);
    console.log(`Deleted workflow "${id}".`);
  });

workflowCommand
  .command('set-default')
  .description('Set the global default workflow')
  .argument('<id>', 'Workflow id')
  .action(async (id: string) => {
    const config = await readConfig();
    const library = getWorkflowLibrary(config);
    if (!library[id]) return fail(`unknown workflow "${id}"`);
    await setDefaultWorkflow(id);
    console.log(`Default workflow is now "${id}".`);
  });

workflowCommand
  .command('bind-type')
  .description('Bind a project’s assignment type to a workflow (project workflowByType)')
  .argument('<project>', 'Project slug')
  .argument('<type>', 'Assignment type (e.g. bug, feature)')
  .argument('<workflow>', 'Workflow id to bind the type to')
  .action(async (project: string, type: string, workflow: string) => {
    const config = await readConfig();
    const library = getWorkflowLibrary(config);
    if (!library[workflow]) return fail(`unknown workflow "${workflow}"`);

    const projectDir = resolve(defaultProjectDir(), project);
    if (!(await fileExists(resolve(projectDir, 'project.md')))) {
      return fail(`unknown project "${project}"`);
    }
    const binding = await readProjectBinding(projectDir);
    binding.workflowByType = { ...binding.workflowByType, [type]: workflow };
    await setProjectWorkflowBinding(projectDir, binding);
    console.log(`Project "${project}": type "${type}" → workflow "${workflow}".`);
  });
