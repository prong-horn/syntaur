import { Command, InvalidArgumentError } from 'commander';
import { initCommand } from './commands/init.js';
import { projectCommand } from './commands/project.js';
import { newCommand } from './commands/new.js';
import { renameCommand } from './commands/rename.js';
import { moveCommand, runMove, MoveRefusedError } from './commands/move.js';
import { dashboardCommand, didUserSpecifyDashboardPort } from './commands/dashboard.js';
import { assignCommand } from './commands/assign.js';
import { unassignCommand } from './commands/unassign.js';
import { archiveCommand } from './commands/archive.js';
import { restoreCommand } from './commands/restore.js';
import { v2MigrateCommand } from './commands/migrate-v2.js';
import { journalMigrateCommand } from './commands/migrate-journal.js';
import { cleanupMigrateCommand } from './commands/migrate-cleanup.js';
import { registerVerbCommands } from './commands/verbs.js';
import { updateCommand } from './commands/update.js';
import { installStatuslineCommand, uninstallStatuslineCommand, type StatuslineMode } from './commands/statusline-install.js';
import { installHooksCommand, uninstallHooksCommand } from './commands/hooks.js';
import { configureStatuslineCommand, PRESETS as STATUSLINE_PRESETS } from './commands/statusline-configure.js';
import { trackSessionCommand } from './commands/track-session.js';
import { doctorCommand } from './commands/doctor.js';
import { usageCommand } from './commands/usage.js';
import { planCommand } from './commands/plan.js';
import { sessionCommand } from './commands/session.js';
import { worktreeCommand } from './commands/worktree.js';
import { openCommand } from './commands/open.js';
import { lsCommand } from './commands/ls.js';
import { searchCommand } from './commands/search.js';
import { timelineCommand } from './commands/timeline.js';
import { historyCommand } from './commands/history.js';
import { inboxCommand } from './commands/inbox.js';
import { templateCommand } from './commands/template.js';
import { retemplateCliCommand } from './commands/retemplate.js';
import { showCommand } from './commands/show.js';
import { workspaceCommand } from './commands/workspace.js';
import { progressCommand } from './commands/progress.js';
import { logCommand } from './commands/log.js';
import { getDefaultCommandName } from './cli-default-command.js';
import { maybePromptInstall } from './utils/npx-prompt.js';
import { maybeNudgeForNpxInstall } from './utils/install-detection.js';
import { readPackageVersion } from './utils/version.js';
import { exitCodeFor, formatCliError, runCommand } from './errors.js';

// Skip the npx/global-install startup nudges for `update`/`upgrade` — that
// command does its own install-kind detection and must stay read-only for
// --check/--dry-run (a startup prompt could install before it even runs).
// Also skip for `setup --dry-run`, which must write nothing at all, and for
// `migrate-workflows` / `migrate`, whose `--root <copy>` isolation is only set
// inside the action — these hooks resolve (and could write) the REAL ~/.syntaur
// before SYNTAUR_HOME is pointed at the copy (codex plan-review round-3 major).
{
  const sub = process.argv[2];
  if (
    sub !== 'update' &&
    sub !== 'upgrade' &&
    sub !== 'migrate-workflows' &&
    sub !== 'migrate'
  ) {
    await maybePromptInstall(import.meta.url);
    await maybeNudgeForNpxInstall(import.meta.url);
  }
}

const program = new Command();
const version = (await readPackageVersion(import.meta.url)) ?? '0.0.0';

program
  .name('syntaur')
  .description('CLI scaffolding tool for the Syntaur protocol')
  .version(version);

program
  .command('init')
  .description('Initialize ~/.syntaur/ directory structure and config')
  .option('--force', 'Overwrite existing config file')
  .option('--no-auto-commit', 'Write home-commit.sh but do not install the daily scheduler entry')
  .action(
    runCommand(async (options) => {
      await initCommand(options);
    }),
  );

program
  .command('new')
  .description('Create a new ticket (defaults to the scratch project when --project is omitted)')
  .argument('<title>', 'Ticket title')
  .option('--project <slug>', 'Target project slug (defaults to scratch)')
  .option('--slug <slug>', 'Override auto-generated display slug')
  .option('--priority <level>', 'Priority level (low|medium|high|critical)')
  .option('-t, --template <id>', 'Ticket template id (defaults to the project defaultTemplate)')
  .option('--depends-on <ids>', 'Comma-separated dependency ticket ids')
  .option('--links <ids>', 'Comma-separated linked ticket ids')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (title, options) => {
      await newCommand(title, {
        ...options,
        depends_on_flag: options.dependsOn,
      });
    }),
  );

program
  .command('rename')
  .description('Rename a ticket slug (folder becomes <ID>-<new-slug>)')
  .argument('<ticket>', 'Ticket id (<PREFIX>-<n>)')
  .argument('<new-slug>', 'New display slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, newSlug, options) => {
      await renameCommand(ticket, newSlug, options);
    }),
  );

program.addCommand(
  moveCommand.action(async (ticket: string | undefined, options) => {
    try {
      const { lines } = await runMove({ ...options, ticket });
      for (const line of lines) console.log(line);
    } catch (error) {
      if (error instanceof MoveRefusedError && error.reportLines?.length) {
        for (const line of error.reportLines) console.log(line);
      }
      console.error(formatCliError(error));
      process.exit(exitCodeFor(error));
    }
  }),
);

program
  .command('dashboard')
  .description('Start the local Syntaur dashboard web UI')
  .option('--port <number>', 'Port to run the dashboard on', '4800')
  .option('--dev', 'Run the dashboard with the Vite dev server', false)
  .option('--server-only', 'Run only the API server without any UI', false)
  .option('--api-only', 'Deprecated alias for --server-only', false)
  .option('--no-open', 'Do not automatically open the browser')
  .action(
    runCommand(async (options) => {
      const autoPort = !didUserSpecifyDashboardPort();
      await dashboardCommand({
        ...options,
        autoPort,
      });
    }),
  );

program
  .command('assign')
  .description('Set the assignee on a ticket')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name to assign')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await assignCommand(ticket, options);
    }),
  );

program
  .command('unassign')
  .description('Clear the assignee on a ticket (inverse of assign)')
  .argument('<ticket>', 'Ticket slug (UUID for standalone)')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await unassignCommand(ticket, options);
    }),
  );

program
  .command('archive')
  .description('Archive a project (hidden from normal views; restorable)')
  .argument('<target>', 'Project slug')
  .option('--reason <text>', 'Optional reason recorded with the archive')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (target, options) => {
      await archiveCommand(target, options);
    }),
  );

program
  .command('restore')
  .description('Restore an archived project')
  .argument('<target>', 'Project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (target, options) => {
      await restoreCommand(target, options);
    }),
  );

registerVerbCommands(program);

program
  .command('update')
  .alias('upgrade')
  .description('Self-update the global syntaur package and refresh session hooks')
  .option('--version <v>', 'Update to a specific version instead of latest')
  .option('--check', 'Report whether an update is available; apply nothing')
  .option('--dry-run', 'Print what would happen without changing anything')
  .option('--skip-refresh', 'Update the package only; do not refresh session hooks')
  .option('--pm <name>', 'Override package-manager detection (npm|pnpm|yarn|bun)')
  .option('--yes', 'Assume yes for any confirmation (non-interactive)')
  .action(
    runCommand(async (options) => {
      await updateCommand({ ...options, scriptUrl: import.meta.url });
    }),
  );

const hooksCommand = new Command('hooks').description('Install or remove Syntaur session hooks in Claude Code settings');
hooksCommand
  .command('install')
  .description('Copy hook scripts to ~/.syntaur/hooks and wire SessionStart, PostToolUse, and UserPromptSubmit in settings.json')
  .action(
    runCommand(async () => {
      await installHooksCommand();
    }),
  );
hooksCommand
  .command('uninstall')
  .description('Remove Syntaur hook entries from settings.json and delete ~/.syntaur/hooks')
  .action(
    runCommand(async () => {
      await uninstallHooksCommand();
    }),
  );
program.addCommand(hooksCommand);

const statuslineCommand = new Command('statusline').description(
  'Install, configure, or remove the syntaur statusLine for Claude Code',
);
statuslineCommand
  .command('install')
  .description(
    'Install the syntaur statusLine. Augments ~/.claude/settings.json; wraps any existing script by default.',
  )
  .option('--mode <mode>', 'replace | wrap | skip | ask (default: ask, wrap in non-TTY)', 'ask')
  .option('--link', 'Symlink the installed script to the package source (dev mode)')
  .action(
    runCommand(async (options: { mode?: string; link?: boolean }) => {
      const rawMode = (options.mode ?? 'ask').toLowerCase();
      const valid: StatuslineMode[] = ['replace', 'wrap', 'skip', 'ask'];
      if (!valid.includes(rawMode as StatuslineMode)) {
        throw new Error(
          `Invalid --mode "${rawMode}". Must be one of: ${valid.join(', ')}.`,
        );
      }
      await installStatuslineCommand({
        mode: rawMode as StatuslineMode,
        link: options.link,
      });
    }),
  );
statuslineCommand
  .command('uninstall')
  .description(
    'Remove the syntaur statusLine. Restores the previously configured command from backup if present.',
  )
  .option('--keep-script', 'Leave ~/.syntaur/statusline.sh on disk (only edit settings.json)')
  .action(
    runCommand(async (options: { keepScript?: boolean }) => {
      await uninstallStatuslineCommand({ keepScript: options.keepScript });
    }),
  );
statuslineCommand
  .command('configure')
  .description(
    'Configure which segments (git, ticket, session, model, ctx, cwd, wrap) appear in the syntaur statusLine and in what order.',
  )
  .option(
    '--preset <name>',
    `Preset shortcut. Choices: ${Object.keys(STATUSLINE_PRESETS).join(', ')}.`,
  )
  .option(
    '--segments <list>',
    'Comma-separated segment list, e.g. "git,ticket,session,model,ctx".',
  )
  .option('--separator <string>', 'Segment separator (default " · ")')
  .option('--wrap <path>', 'Path to an external statusline script to compose as a "wrap" segment')
  .option('--preview', 'Print the resolved config and a preview line without writing')
  .action(
    runCommand(async (options: { preset?: string; segments?: string; separator?: string; wrap?: string; preview?: boolean }) => {
      await configureStatuslineCommand(options);
    }),
  );
program.addCommand(statuslineCommand);

program
  .command('track-session')
  .description('Register an agent session (optionally linked to a project/ticket)')
  .option('--project <slug>', 'Target project slug')
  .option('--ticket <id>', 'Ticket id')
  .option('--agent <name>', 'Agent name, e.g. claude, codex, cursor (required)')
  .option(
    '--session-id <id>',
    'Session id from the agent runtime (real, not generated). Defaults to self-resolution via env / process-tree markers / transcript scan — pass explicitly only when registering a session other than the calling one.',
  )
  .option(
    '--transcript-path <path>',
    'Absolute path to the agent rollout/transcript file (e.g. the Codex rollout jsonl or Claude transcript jsonl).',
  )
  .option('--path <path>', 'Full path to session on disk (defaults to cwd)')
  .option('--dir <path>', 'Override default project directory')
  .option('--description <text>', 'Description of what this session is for')
  .action(
    runCommand(async (options) => {
      await trackSessionCommand(options);
    }),
  );

const migrateCommand = new Command('migrate').description('One-time data migrations');
migrateCommand.addCommand(v2MigrateCommand);
migrateCommand.addCommand(journalMigrateCommand);
migrateCommand.addCommand(cleanupMigrateCommand);
program.addCommand(migrateCommand);

program.addCommand(doctorCommand);
program.addCommand(projectCommand);
program.addCommand(planCommand);
program.addCommand(sessionCommand);
program.addCommand(worktreeCommand);
program.addCommand(openCommand);
program.addCommand(lsCommand);
program.addCommand(searchCommand);
program.addCommand(timelineCommand);
program.addCommand(historyCommand);
program.addCommand(inboxCommand);
program.addCommand(templateCommand);
program.addCommand(retemplateCliCommand);
program.addCommand(showCommand);
program.addCommand(workspaceCommand);
program.addCommand(logCommand);
program.addCommand(progressCommand);
program.addCommand(usageCommand);

program.addHelpText(
  'after',
  `
Common workflow:
  $ syntaur init                                   Initialize ~/.syntaur/
  $ syntaur project new "My App"                   Start a new project
  $ syntaur new --project my-app "Add login"   Add a ticket to a project
  $ syntaur dashboard                              Open the local web dashboard
  $ syntaur doctor                                 Diagnose Syntaur state & suggested fixes

Run 'syntaur <command> --help' for command-specific options.
Migration/internal commands (migrate-*) are advanced; most
workflows never need them.`,
);

// Default to dashboard when no command is given
if (process.argv.length <= 2) {
  process.argv.push(await getDefaultCommandName());
}

await program.parseAsync();
