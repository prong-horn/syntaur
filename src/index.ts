import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { createMissionCommand } from './commands/create-mission.js';
import { createAssignmentCommand } from './commands/create-assignment.js';
import { dashboardCommand } from './commands/dashboard.js';
import { assignCommand } from './commands/assign.js';
import { startCommand } from './commands/start.js';
import { completeCommand } from './commands/complete.js';
import { blockCommand } from './commands/block.js';
import { unblockCommand } from './commands/unblock.js';
import { reviewCommand } from './commands/review.js';
import { failCommand } from './commands/fail.js';
import { reopenCommand } from './commands/reopen.js';
import { installPluginCommand } from './commands/install-plugin.js';
import { setupAdapterCommand } from './commands/setup-adapter.js';

const program = new Command();

program
  .name('syntaur')
  .description('CLI scaffolding tool for the Syntaur protocol')
  .version('0.1.0');

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
  .command('create-mission')
  .description('Create a new mission with all required files')
  .argument('<title>', 'Mission title')
  .option('--slug <slug>', 'Override auto-generated slug')
  .option('--dir <path>', 'Override default mission directory')
  .action(async (title, options) => {
    try {
      await createMissionCommand(title, options);
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
  .description('Create a new assignment within a mission')
  .argument('<title>', 'Assignment title')
  .option('--mission <slug>', 'Target mission slug (required unless --one-off)')
  .option('--one-off', 'Auto-wrap in a new single-assignment mission')
  .option('--slug <slug>', 'Override auto-generated slug')
  .option(
    '--priority <level>',
    'Priority level (low|medium|high|critical)',
    'medium',
  )
  .option('--depends-on <slugs>', 'Comma-separated dependency slugs')
  .option('--dir <path>', 'Override default mission directory')
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
  .command('dashboard')
  .description('Start the local Syntaur dashboard web UI')
  .option('--port <number>', 'Port to run the dashboard on', '4800')
  .option('--dev', 'Run in development mode (API only, use with Vite dev server)', false)
  .option('--no-open', 'Do not automatically open the browser')
  .action(async (options) => {
    try {
      await dashboardCommand(options);
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
  .option('--mission <slug>', 'Target mission slug')
  .option('--agent <name>', 'Agent name to assign')
  .option('--dir <path>', 'Override default mission directory')
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
  .option('--mission <slug>', 'Target mission slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default mission directory')
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
  .option('--mission <slug>', 'Target mission slug')
  .option('--dir <path>', 'Override default mission directory')
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
  .option('--mission <slug>', 'Target mission slug')
  .option('--reason <text>', 'Reason for blocking')
  .option('--dir <path>', 'Override default mission directory')
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
  .option('--mission <slug>', 'Target mission slug')
  .option('--dir <path>', 'Override default mission directory')
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
  .option('--mission <slug>', 'Target mission slug')
  .option('--dir <path>', 'Override default mission directory')
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
  .option('--mission <slug>', 'Target mission slug')
  .option('--dir <path>', 'Override default mission directory')
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
  .option('--mission <slug>', 'Target mission slug')
  .option('--dir <path>', 'Override default mission directory')
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
  .command('install-plugin')
  .description('Install the Syntaur Claude Code plugin via symlink')
  .option('--force', 'Overwrite existing plugin installation')
  .action(async (options) => {
    try {
      await installPluginCommand(options);
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
  .option('--mission <slug>', 'Target mission slug (required)')
  .option('--assignment <slug>', 'Target assignment slug (required)')
  .option('--force', 'Overwrite existing adapter files')
  .option('--dir <path>', 'Override default mission directory')
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

program.parse();
