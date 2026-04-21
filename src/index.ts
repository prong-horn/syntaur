import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { createProjectCommand } from './commands/create-project.js';
import { createAssignmentCommand } from './commands/create-assignment.js';
import { dashboardCommand, didUserSpecifyDashboardPort } from './commands/dashboard.js';
import { assignCommand } from './commands/assign.js';
import { startCommand } from './commands/start.js';
import { completeCommand } from './commands/complete.js';
import { blockCommand } from './commands/block.js';
import { unblockCommand } from './commands/unblock.js';
import { reviewCommand } from './commands/review.js';
import { failCommand } from './commands/fail.js';
import { reopenCommand } from './commands/reopen.js';
import { installPluginCommand } from './commands/install-plugin.js';
import { installCodexPluginCommand } from './commands/install-codex-plugin.js';
import { setupCommand } from './commands/setup.js';
import { uninstallCommand } from './commands/uninstall.js';
import { setupAdapterCommand } from './commands/setup-adapter.js';
import { trackSessionCommand } from './commands/track-session.js';
import { browseCommand } from './commands/browse.js';
import { createPlaybookCommand } from './commands/create-playbook.js';
import { listPlaybooksCommand } from './commands/list-playbooks.js';
import { todoCommand } from './commands/todo.js';
import { backupCommand } from './commands/backup.js';
import { doctorCommand } from './commands/doctor.js';
import { commentCommand } from './commands/comment.js';
import { requestCommand } from './commands/request.js';
import { getDefaultCommandName } from './cli-default-command.js';
import { maybePromptInstall } from './utils/npx-prompt.js';
import { readPackageVersion } from './utils/version.js';

await maybePromptInstall(import.meta.url);

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
  .action(async (options) => {
    try {
      await initCommand(options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('create-project')
  .description('Create a new project with all required files')
  .argument('<title>', 'Project title')
  .option('--slug <slug>', 'Override auto-generated slug')
  .option('--dir <path>', 'Override default project directory')
  .option('--workspace <workspace>', 'Workspace for organizational grouping')
  .action(async (title, options) => {
    try {
      await createProjectCommand(title, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('create-assignment')
  .description('Create a new assignment within a project')
  .argument('<title>', 'Assignment title')
  .option('--project <slug>', 'Target project slug (required unless --one-off)')
  .option('--one-off', 'Create a standalone assignment at ~/.syntaur/assignments/<uuid>/')
  .option('--slug <slug>', 'Override auto-generated slug (display only for standalone; folder name for project-nested)')
  .option(
    '--priority <level>',
    'Priority level (low|medium|high|critical)',
    'medium',
  )
  .option('--type <type>', 'Assignment type (e.g. feature, bug, refactor)')
  .option('--depends-on <slugs>', 'Comma-separated dependency slugs (not allowed with --one-off)')
  .option('--links <slugs>', 'Comma-separated linked assignment slugs (projectSlug/assignmentSlug format)')
  .option('--dir <path>', 'Override default project directory (ignored for --one-off)')
  .action(async (title, options) => {
    try {
      await createAssignmentCommand(title, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('comment')
  .description('Add a comment to an assignment (CLI-mediated, append-only)')
  .argument('<assignment>', 'Target assignment slug (with --project) or UUID (standalone)')
  .argument('<text>', 'Comment body')
  .option('--project <slug>', 'Project slug if the target is project-nested')
  .option('--reply-to <id>', 'ID of the comment this replies to')
  .option('--type <type>', 'Comment type: question | note | feedback', 'note')
  .option('--author <name>', 'Override author (default: $USER or "unknown")')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, text, options) => {
    try {
      await commentCommand(assignment, text, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('request')
  .description('Append a todo to another assignment (cross-assignment work request)')
  .argument('<target>', 'Target assignment slug (with --project) or UUID (standalone)')
  .argument('<text>', 'Todo text')
  .option('--project <slug>', 'Project slug if the target is project-nested')
  .option('--from <source>', 'Source assignment (default: $SYNTAUR_ASSIGNMENT)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (target, text, options) => {
    try {
      await requestCommand(target, text, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('dashboard')
  .description('Start the local Syntaur dashboard web UI')
  .option('--port <number>', 'Port to run the dashboard on', '4800')
  .option('--dev', 'Run the dashboard with the Vite dev server', false)
  .option('--server-only', 'Run only the API server without any UI', false)
  .option('--api-only', 'Deprecated alias for --server-only', false)
  .option('--no-open', 'Do not automatically open the browser')
  .action(async (options) => {
    try {
      const autoPort = !didUserSpecifyDashboardPort();
      await dashboardCommand({
        ...options,
        autoPort,
      });
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('assign')
  .description('Set the assignee on an assignment')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name to assign')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await assignCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('start')
  .description('Transition an assignment to in_progress')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await startCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('complete')
  .description('Transition an assignment to completed')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await completeCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('block')
  .description('Transition an assignment to blocked')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--reason <text>', 'Reason for blocking')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await blockCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('unblock')
  .description('Transition a blocked assignment to in_progress')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await unblockCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('review')
  .description('Transition an assignment to review')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await reviewCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('fail')
  .description('Transition an assignment to failed')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await failCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('reopen')
  .description('Reopen a completed or failed assignment')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await reopenCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('setup')
  .description('Initialize Syntaur and optionally install plugins or launch the dashboard')
  .option('--yes', 'Skip interactive prompts and perform only the requested flags')
  .option('--claude', 'Install the Claude Code plugin')
  .option('--codex', 'Install the Codex plugin')
  .option('--claude-dir <path>', 'Install the Claude Code plugin at a specific path')
  .option('--codex-dir <path>', 'Install the Codex plugin at a specific path')
  .option('--codex-marketplace-path <path>', 'Write the Codex marketplace entry to a specific file')
  .option('--dashboard', 'Launch the dashboard after setup')
  .action(async (options) => {
    try {
      await setupCommand(options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('install-plugin')
  .description('Install the Syntaur Claude Code plugin')
  .option('--force', 'Overwrite an existing Syntaur-managed install')
  .option('--target-dir <path>', 'Install the plugin at a specific directory')
  .option('--link', 'Use a symlink instead of copying files (repo-local dev only)')
  .action(async (options) => {
    try {
      await installPluginCommand({ ...options, promptForTarget: true });
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('install-codex-plugin')
  .description('Install the Syntaur Codex plugin and marketplace entry')
  .option('--force', 'Overwrite an existing Syntaur-managed install')
  .option('--target-dir <path>', 'Install the plugin at a specific directory')
  .option('--marketplace-path <path>', 'Write the marketplace entry to a specific file')
  .option('--link', 'Use a symlink instead of copying files (repo-local dev only)')
  .action(async (options) => {
    try {
      await installCodexPluginCommand({ ...options, promptForTarget: true });
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('uninstall')
  .description('Remove Syntaur integrations and optionally local data')
  .option('--claude', 'Remove only the Claude Code plugin')
  .option('--codex', 'Remove only the Codex plugin and marketplace entry')
  .option('--data', 'Remove ~/.syntaur data')
  .option('--all', 'Remove plugins and ~/.syntaur data')
  .option('--yes', 'Skip confirmation prompts')
  .action(async (options) => {
    try {
      await uninstallCommand(options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('setup-adapter')
  .description('Generate adapter instruction files for a framework in the current directory')
  .argument('<framework>', 'Target framework (cursor, codex, opencode)')
  .option('--project <slug>', 'Target project slug (required)')
  .option('--assignment <slug>', 'Target assignment slug (required)')
  .option('--force', 'Overwrite existing adapter files')
  .option('--dir <path>', 'Override default project directory')
  .action(async (framework, options) => {
    try {
      await setupAdapterCommand(framework, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('track-session')
  .description('Register an agent session (optionally linked to a project/assignment)')
  .option('--project <slug>', 'Target project slug')
  .option('--assignment <slug>', 'Assignment slug')
  .option('--agent <name>', 'Agent name, e.g. claude, codex, cursor (required)')
  .requiredOption(
    '--session-id <id>',
    'Session id from the agent runtime (real, not generated). Claude: read from ~/.claude/sessions/<pid>.json or the SessionStart hook payload. Codex: `payload.id` from the first line of the matching ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.',
  )
  .option(
    '--transcript-path <path>',
    'Absolute path to the agent rollout/transcript file (e.g. the Codex rollout jsonl or Claude transcript jsonl).',
  )
  .option('--path <path>', 'Full path to session on disk (defaults to cwd)')
  .option('--dir <path>', 'Override default project directory')
  .option('--description <text>', 'Description of what this session is for')
  .action(async (options) => {
    try {
      await trackSessionCommand(options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('browse')
  .description('Interactive TUI browser for projects and assignments')
  .option('--agent <type>', 'Agent to launch: claude or codex', 'claude')
  .action(async (options) => {
    try {
      await browseCommand(options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('create-playbook')
  .description('Create a new playbook')
  .argument('<name>', 'Playbook name')
  .option('--slug <slug>', 'Override auto-generated slug')
  .option('--description <desc>', 'Playbook description')
  .action(async (name, options) => {
    try {
      await createPlaybookCommand(name, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('list-playbooks')
  .description('List all playbooks')
  .action(async () => {
    try {
      await listPlaybooksCommand();
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program.addCommand(todoCommand);
program.addCommand(backupCommand);
program.addCommand(doctorCommand);

// Default to dashboard when no command is given
if (process.argv.length <= 2) {
  process.argv.push(await getDefaultCommandName());
}

await program.parseAsync();
