import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { createMissionCommand } from './commands/create-mission.js';
import { createAssignmentCommand } from './commands/create-assignment.js';

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

program.parse();
