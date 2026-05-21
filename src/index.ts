import { Command, InvalidArgumentError } from 'commander';
import { initCommand } from './commands/init.js';
import { createProjectCommand } from './commands/create-project.js';
import { createAssignmentCommand } from './commands/create-assignment.js';
import { dashboardCommand, didUserSpecifyDashboardPort } from './commands/dashboard.js';
import { assignCommand } from './commands/assign.js';
import { startCommand } from './commands/start.js';
import { shapeCommand } from './commands/shape.js';
import { planReadyCommand } from './commands/plan-ready.js';
import { implementCommand } from './commands/implement.js';
import { migrateStatusesCommand } from './commands/migrate-statuses.js';
import { completeCommand } from './commands/complete.js';
import { blockCommand } from './commands/block.js';
import { unblockCommand } from './commands/unblock.js';
import { reviewCommand } from './commands/review.js';
import { failCommand } from './commands/fail.js';
import { reopenCommand } from './commands/reopen.js';
import { installPluginCommand } from './commands/install-plugin.js';
import { installStatuslineCommand, uninstallStatuslineCommand, type StatuslineMode } from './commands/install-statusline.js';
import { configureStatuslineCommand, PRESETS as STATUSLINE_PRESETS } from './commands/configure-statusline.js';
import { installCodexPluginCommand } from './commands/install-codex-plugin.js';
import { uninstallSkillsCommand } from './commands/uninstall-skills.js';
import { setupCommand } from './commands/setup.js';
import { uninstallCommand } from './commands/uninstall.js';
import { setupAdapterCommand } from './commands/setup-adapter.js';
import { trackSessionCommand } from './commands/track-session.js';
import { urlCommand, formatUrlCommandError } from './commands/url.js';
import {
  installUrlHandlerCommand,
  formatInstallUrlHandlerError,
} from './commands/install-url-handler.js';
import { browseCommand } from './commands/browse.js';
import { createPlaybookCommand } from './commands/create-playbook.js';
import { listPlaybooksCommand } from './commands/list-playbooks.js';
import { enablePlaybookCommand } from './commands/enable-playbook.js';
import { disablePlaybookCommand } from './commands/disable-playbook.js';
import { deletePlaybookCommand } from './commands/delete-playbook.js';
import { regenPlaybookManifestCommand } from './commands/regen-playbook-manifest.js';
import { todoCommand } from './commands/todo.js';
import { backupCommand } from './commands/backup.js';
import { doctorCommand } from './commands/doctor.js';
import { agentsCommand } from './commands/agents.js';
import { commentCommand } from './commands/comment.js';
import { captureCommand } from './commands/capture.js';
import { proofCommand } from './commands/proof.js';
import { leaseCommand } from './commands/lease.js';
import { usageCommand } from './commands/usage.js';
import { requestCommand } from './commands/request.js';
import { planCommand } from './commands/plan.js';
import { sessionCommand } from './commands/session.js';
import { worktreeCommand } from './commands/worktree.js';
import { resourceCommand } from './commands/resource.js';
import { memoryCommand } from './commands/memory.js';
import { lsCommand } from './commands/ls.js';
import { getDefaultCommandName } from './cli-default-command.js';
import { maybePromptInstall } from './utils/npx-prompt.js';
import { maybeNudgeForNpxInstall } from './launch/index.js';
import { spliceDashDashFromArgv } from './utils/argv-split.js';
import { readPackageVersion } from './utils/version.js';

await maybePromptInstall(import.meta.url);
await maybeNudgeForNpxInstall(import.meta.url);

let captureDashDashArgv: string[] = [];

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
  .option('--with-todos', 'Scaffold a ## Todos section in assignment.md (omitted by default; typically populated by /plan-assignment)')
  .option('--workspace <slug>', 'Workspace group slug (only valid with --one-off; mutually exclusive with --project)')
  .option('--ready', 'Create the assignment directly as ready_for_planning (skips the draft phase)')
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
  .command('capture')
  .description('Capture a typed proof artifact for an assignment')
  .argument('[target]', 'Assignment slug (with --project) or UUID; falls back to .syntaur/context.json')
  .option('--kind <type>', 'Artifact kind: screenshot | video | asciinema | http | text')
  .option('--file <path>', 'Source file to ingest (forbidden for --kind=text)')
  .option('--criterion <index>', 'Optional 0-based criterion index to tag')
  .option('--note <text>', 'Optional note (required for --kind=text)')
  .option('--project <slug>', 'Project slug if the target is project-nested')
  .option('--dir <path>', 'Override default project directory')
  .option('--interactive', 'Interactive mode: drag a region (--kind=screenshot) or record a TTY (--kind=asciinema)')
  .option('--window', 'Screenshot mode: window picker (macOS only)')
  .option('--fullscreen', 'Screenshot mode: silent full-screen capture (macOS only)')
  .option('--start', 'Start ffmpeg screen recording in the background (macOS only). Stop with --stop.')
  .option('--stop', 'Stop the running ffmpeg recording and attach the mp4.')
  .option('--device <index>', 'AVFoundation video device index for --start (default: 1). List devices: ffmpeg -f avfoundation -list_devices true -i ""')
  .option('--fps <n>', 'Frame rate for --start (default: 30)')
  .option('--transcribe', 'Auto-transcribe captured video to a <id>.transcript.md sidecar (kind=video only; requires ELEVENLABS_API_KEY + ffmpeg)')
  .action(async (target, options) => {
    try {
      await captureCommand(target, {
        ...options,
        commandArgv: captureDashDashArgv,
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
  .command('shape')
  .description('Transition an assignment from draft to ready_for_planning')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await shapeCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('plan-ready')
  .description('Transition an assignment from ready_for_planning to ready_to_implement')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await planReadyCommand(assignment, options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('migrate-statuses')
  .description('Suggest pending -> ready_for_planning promotions for fleshed-out assignments (use --apply to write)')
  .option('--dir <path>', 'Override default project directory')
  .option('--apply', 'Apply the migration (default: dry-run)')
  .action(async (options) => {
    try {
      await migrateStatusesCommand(options);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('implement')
  .description('Transition an assignment from ready_to_implement to in_progress')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(async (assignment, options) => {
    try {
      await implementCommand(assignment, options);
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
  .option('--force-skills', 'Overwrite user-edited skills in ~/.claude/skills')
  .option('--skip-skills', 'Do not install protocol skills into ~/.claude/skills')
  .option('--enable', 'Enable the plugin in ~/.claude/settings.json after install')
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
  .command('install-statusline')
  .description(
    'Install the syntaur statusLine for Claude Code. Augments ~/.claude/settings.json; wraps any existing script by default.',
  )
  .option('--mode <mode>', 'replace | wrap | skip | ask (default: ask, wrap in non-TTY)', 'ask')
  .option('--link', 'Symlink the installed script to the package source (dev mode)')
  .action(async (options: { mode?: string; link?: boolean }) => {
    try {
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
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('uninstall-statusline')
  .description(
    'Remove the syntaur statusLine. Restores the previously configured command from backup if present.',
  )
  .option('--keep-script', 'Leave ~/.syntaur/statusline.sh on disk (only edit settings.json)')
  .action(async (options: { keepScript?: boolean }) => {
    try {
      await uninstallStatuslineCommand({ keepScript: options.keepScript });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('configure-statusline')
  .description(
    'Configure which segments (git, assignment, session, model, ctx, cwd, wrap) appear in the syntaur statusLine and in what order.',
  )
  .option(
    '--preset <name>',
    `Preset shortcut. Choices: ${Object.keys(STATUSLINE_PRESETS).join(', ')}.`,
  )
  .option(
    '--segments <list>',
    'Comma-separated segment list, e.g. "git,assignment,session,model,ctx".',
  )
  .option('--separator <string>', 'Segment separator (default " · ")')
  .option('--wrap <path>', 'Path to an external statusline script to compose as a "wrap" segment')
  .option('--preview', 'Print the resolved config and a preview line without writing')
  .action(async (options: { preset?: string; segments?: string; separator?: string; wrap?: string; preview?: boolean }) => {
    try {
      await configureStatuslineCommand(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('uninstall-skills')
  .description('Remove Syntaur protocol skills from ~/.claude/skills and/or ~/.codex/skills')
  .option('--claude', 'Remove from ~/.claude/skills')
  .option('--codex', 'Remove from ~/.codex/skills')
  .option('--all', 'Remove from both')
  .action(async (options: { claude?: boolean; codex?: boolean; all?: boolean }) => {
    try {
      await uninstallSkillsCommand(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
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
  .option('--force-skills', 'Overwrite user-edited skills in ~/.codex/skills')
  .option('--skip-skills', 'Do not install protocol skills into ~/.codex/skills')
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
  .option(
    '--pid <n>',
    'Process ID owning this session — enables liveness detection so Resume is disabled while the process is still running.',
    (v) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new InvalidArgumentError('--pid must be a positive integer');
      }
      return n;
    },
  )
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
  .command('url <url>')
  .description(
    'Open an assignment or session in the configured terminal + agent (handles syntaur:// deep links)',
  )
  .option(
    '--print-plan',
    'Print the launch plan to stdout (two lines: terminal id, shell command) instead of executing. Used internally by the macOS URL handler applet so Apple Events come from the applet rather than from a subprocess.',
  )
  .action(async (url: string, options: { printPlan?: boolean }) => {
    try {
      await urlCommand(url, { printPlan: options.printPlan });
    } catch (error) {
      console.error(formatUrlCommandError(error));
      process.exit(1);
    }
  });

program
  .command('install-url-handler')
  .description(
    'Register the syntaur:// deep-link handler with the OS. macOS-only today. Refuses to register from an npx cache or unrecognized install.',
  )
  .action(async () => {
    try {
      await installUrlHandlerCommand({ scriptUrl: import.meta.url });
    } catch (error) {
      console.error(formatInstallUrlHandlerError(error));
      process.exit(1);
    }
  });

program
  .command('browse')
  .description('Interactive TUI browser for projects and assignments')
  .option('--agent <id>', 'Bypass the agent picker and launch the given configured agent id')
  .option('--no-worktree-prompt', 'Skip the prompt to create a worktree when one is missing')
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
  .description('List playbooks (disabled playbooks are excluded unless --all is passed)')
  .option('--all', 'Include disabled playbooks')
  .action(async (options) => {
    try {
      await listPlaybooksCommand({ all: Boolean(options?.all) });
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('enable-playbook')
  .description('Enable a previously-disabled playbook')
  .argument('<slug>', 'Playbook slug')
  .action(async (slug) => {
    try {
      await enablePlaybookCommand(slug);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('disable-playbook')
  .description('Disable a playbook so agents no longer load it')
  .argument('<slug>', 'Playbook slug')
  .action(async (slug) => {
    try {
      await disablePlaybookCommand(slug);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('delete-playbook')
  .description('Delete a playbook from disk and regenerate the manifest')
  .argument('<slug>', 'Playbook slug')
  .action(async (slug) => {
    try {
      await deletePlaybookCommand(slug);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command('regen-playbook-manifest')
  .description('Rebuild ~/.syntaur/playbooks/manifest.md from current playbook files')
  .action(async () => {
    try {
      await regenPlaybookManifestCommand();
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
program.addCommand(agentsCommand);
program.addCommand(proofCommand);
program.addCommand(planCommand);
program.addCommand(sessionCommand);
program.addCommand(worktreeCommand);
program.addCommand(resourceCommand);
program.addCommand(memoryCommand);
program.addCommand(lsCommand);
program.addCommand(leaseCommand);
program.addCommand(usageCommand);

// Default to dashboard when no command is given
if (process.argv.length <= 2) {
  process.argv.push(await getDefaultCommandName());
}

captureDashDashArgv = spliceDashDashFromArgv(process.argv);
await program.parseAsync();
