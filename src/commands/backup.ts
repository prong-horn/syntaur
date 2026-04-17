import { Command } from 'commander';
import { updateBackupConfig } from '../utils/config.js';
import {
  backupToGithub,
  restoreFromGithub,
  getBackupStatus,
  parseCategoriesStrict,
  validateRepoUrl,
  VALID_CATEGORIES,
  type BackupCategory,
} from '../utils/github-backup.js';

function parseCategoryOption(csv: string | undefined): BackupCategory[] | undefined {
  if (!csv) return undefined;
  const parts = csv.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`No categories provided. Valid: ${VALID_CATEGORIES.join(', ')}`);
  }
  return parseCategoriesStrict(parts);
}

export const backupCommand = new Command('backup')
  .description('Back up Syntaur files to a GitHub repository');

backupCommand
  .command('push')
  .description('Push a backup to the configured GitHub repo')
  .option('--repo <url>', 'Override the configured repo URL')
  .option('--categories <list>', 'Comma-separated categories to back up (missions, playbooks, todos, servers, config)')
  .action(async (options) => {
    try {
      const result = await backupToGithub({
        repo: options.repo,
        categories: parseCategoryOption(options.categories),
      });
      console.log(result.message);
      if (result.committed) {
        console.log(`  timestamp: ${result.timestamp}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

backupCommand
  .command('pull')
  .description('Restore Syntaur files from the configured GitHub repo')
  .option('--repo <url>', 'Override the configured repo URL')
  .option('--categories <list>', 'Comma-separated categories to restore')
  .action(async (options) => {
    try {
      const result = await restoreFromGithub({
        repo: options.repo,
        categories: parseCategoryOption(options.categories),
      });
      console.log(result.message);
      console.log(`  timestamp: ${result.timestamp}`);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

backupCommand
  .command('config')
  .description('Show or update backup configuration')
  .option('--repo <url>', 'Set the backup repo URL')
  .option('--categories <list>', 'Set the default categories (comma-separated)')
  .action(async (options) => {
    try {
      const updates: { repo?: string; categories?: string } = {};

      if (options.repo !== undefined) {
        const trimmed = typeof options.repo === 'string' ? options.repo.trim() : options.repo;
        if (!validateRepoUrl(trimmed)) {
          throw new Error(`Invalid repo URL: "${options.repo}". Must start with https:// or git@.`);
        }
        updates.repo = trimmed;
      }
      if (options.categories !== undefined) {
        const parts = options.categories.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (parts.length === 0) {
          throw new Error(`No categories provided. Valid: ${VALID_CATEGORIES.join(', ')}`);
        }
        const valid = parseCategoriesStrict(parts);
        updates.categories = valid.join(', ');
      }

      if (Object.keys(updates).length > 0) {
        await updateBackupConfig(updates);
        console.log('Backup configuration updated.');
      }

      const status = await getBackupStatus();
      console.log('\nBackup configuration:');
      console.log(`  repo:        ${status.repo ?? '(not set)'}`);
      console.log(`  categories:  ${status.categories}`);
      console.log(`  lastBackup:  ${status.lastBackup ?? '(never)'}`);
      console.log(`  lastRestore: ${status.lastRestore ?? '(never)'}`);
      if (status.locked) {
        console.log('  ⚠ locked:    a backup operation is in progress or the lock is stale');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
