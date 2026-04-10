import { initCommand } from './init.js';
import { dashboardCommand, findAvailablePort } from './dashboard.js';
import { installPluginCommand } from './install-plugin.js';
import { installCodexPluginCommand } from './install-codex-plugin.js';
import { isSyntaurDataInstalled, getPluginInstallCommand } from '../utils/install.js';
import { confirmPrompt, isInteractiveTerminal } from '../utils/prompt.js';
import { updateOnboardingConfig } from '../utils/config.js';

export interface SetupOptions {
  yes?: boolean;
  claude?: boolean;
  codex?: boolean;
  dashboard?: boolean;
  claudeDir?: string;
  codexDir?: string;
  codexMarketplacePath?: string;
}

function printNonInteractiveSetupHelp(): void {
  console.error('Syntaur setup needs confirmation for optional steps when no TTY is available.');
  console.error('Run one of these commands instead:');
  console.error('  npx syntaur@latest setup --yes');
  console.error('  npx syntaur@latest setup --yes --claude');
  console.error('  npx syntaur@latest setup --yes --codex');
  console.error(`  npx syntaur@latest setup --yes --dashboard`);
}

export async function setupCommand(options: SetupOptions): Promise<void> {
  const initialized = await isSyntaurDataInstalled();
  const interactive = isInteractiveTerminal();

  if (!initialized) {
    if (!interactive && !options.yes && !options.claude && !options.codex && !options.dashboard) {
      printNonInteractiveSetupHelp();
      throw new Error('Non-interactive setup requires --yes and any optional follow-up flags.');
    }

    await initCommand({});
  } else {
    console.log('Syntaur is already initialized.');
  }

  let installClaude = Boolean(options.claude);
  let installCodex = Boolean(options.codex);
  let launchDashboard = Boolean(options.dashboard);

  if (interactive && !options.yes) {
    if (!options.claude) {
      installClaude = await confirmPrompt('Install the Claude Code plugin?');
    }
    if (!options.codex) {
      installCodex = await confirmPrompt('Install the Codex plugin?');
    }
    if (!options.dashboard) {
      launchDashboard = await confirmPrompt('Launch the dashboard now?', true);
    }
  }

  if (installClaude) {
    await installPluginCommand({
      targetDir: options.claudeDir,
      promptForTarget: !options.yes,
    });
  } else {
    console.log(`Skip Claude plugin for now. Install later with: ${getPluginInstallCommand('claude')}`);
  }

  if (installCodex) {
    await installCodexPluginCommand({
      targetDir: options.codexDir,
      marketplacePath: options.codexMarketplacePath,
      promptForTarget: !options.yes,
    });
  } else {
    console.log(`Skip Codex plugin for now. Install later with: ${getPluginInstallCommand('codex')}`);
  }

  if (launchDashboard) {
    const preferredPort = 4800;
    const port = await findAvailablePort(preferredPort);
    if (port === null) {
      throw new Error(
        `Could not find an available dashboard port starting at ${preferredPort}. Run "syntaur dashboard --port <number>" to choose one manually.`,
      );
    }
    if (port !== preferredPort) {
      console.log(`Port ${preferredPort} is busy. Launching the dashboard on port ${port} instead.`);
    }
    await updateOnboardingConfig({ completed: true });
    await dashboardCommand({
      port: String(port),
      dev: false,
      serverOnly: false,
      apiOnly: false,
      open: true,
    });
    return;
  }

  await updateOnboardingConfig({ completed: true });

  if (!initialized) {
    console.log('\nNext steps:');
    console.log('  npx syntaur@latest create-mission "My First Mission"');
    console.log('  npx syntaur@latest dashboard');
  }
}
