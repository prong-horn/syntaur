import { resolve } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { fileExists, writeFileSafe, writeFileForce } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { renderCursorProtocol, renderCursorAssignment } from '../templates/cursor-rules.js';
import { renderCodexAgents } from '../templates/codex-agents.js';
import { renderOpenCodeConfig } from '../templates/opencode-config.js';

const SUPPORTED_FRAMEWORKS = ['cursor', 'codex', 'opencode'] as const;
type Framework = (typeof SUPPORTED_FRAMEWORKS)[number];

export interface SetupAdapterOptions {
  project: string;
  assignment: string;
  force?: boolean;
  dir?: string;
}

export async function setupAdapterCommand(
  framework: string,
  options: SetupAdapterOptions,
): Promise<void> {
  // Validate framework
  if (!SUPPORTED_FRAMEWORKS.includes(framework as Framework)) {
    throw new Error(
      `Unsupported framework "${framework}". Supported: ${SUPPORTED_FRAMEWORKS.join(', ')}`,
    );
  }

  // Validate required options
  if (!options.project) {
    throw new Error('--project <slug> is required.');
  }
  if (!options.assignment) {
    throw new Error('--assignment <slug> is required.');
  }
  if (!isValidSlug(options.project)) {
    throw new Error(
      `Invalid project slug "${options.project}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }
  if (!isValidSlug(options.assignment)) {
    throw new Error(
      `Invalid assignment slug "${options.assignment}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  // Resolve paths
  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultProjectDir;
  const projectDir = resolve(baseDir, options.project);
  const assignmentDir = resolve(
    projectDir,
    'assignments',
    options.assignment,
  );

  // Verify project exists
  const projectMdPath = resolve(projectDir, 'project.md');
  if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
    throw new Error(
      `Project "${options.project}" not found at ${projectDir}.`,
    );
  }

  // Verify assignment exists
  const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
  if (!(await fileExists(assignmentDir)) || !(await fileExists(assignmentMdPath))) {
    throw new Error(
      `Assignment "${options.assignment}" not found at ${assignmentDir}.`,
    );
  }

  const cwd = process.cwd();
  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];

  const rendererParams = {
    projectSlug: options.project,
    assignmentSlug: options.assignment,
    projectDir,
    assignmentDir,
  };

  async function writeAdapterFile(filePath: string, content: string): Promise<void> {
    if (options.force) {
      await writeFileForce(filePath, content);
      writtenFiles.push(filePath);
    } else {
      if (await writeFileSafe(filePath, content)) {
        writtenFiles.push(filePath);
      } else {
        skippedFiles.push(filePath);
      }
    }
  }

  if (framework === 'cursor') {
    const protocolPath = resolve(cwd, '.cursor', 'rules', 'syntaur-protocol.mdc');
    const assignmentPath = resolve(cwd, '.cursor', 'rules', 'syntaur-assignment.mdc');

    await writeAdapterFile(protocolPath, renderCursorProtocol());
    await writeAdapterFile(assignmentPath, renderCursorAssignment(rendererParams));
  } else if (framework === 'codex' || framework === 'opencode') {
    const agentsPath = resolve(cwd, 'AGENTS.md');
    await writeAdapterFile(agentsPath, renderCodexAgents(rendererParams));

    if (framework === 'opencode') {
      const configPath = resolve(cwd, 'opencode.json');
      await writeAdapterFile(configPath, renderOpenCodeConfig({ projectDir }));
    }
  }

  // Output results
  if (writtenFiles.length > 0) {
    console.log(`Generated ${framework} adapter files:`);
    for (const f of writtenFiles) {
      console.log(`  ${f}`);
    }
  }
  if (skippedFiles.length > 0) {
    console.log(`Skipped (already exist, use --force to overwrite):`);
    for (const f of skippedFiles) {
      console.log(`  ${f}`);
    }
  }
  if (writtenFiles.length === 0 && skippedFiles.length > 0) {
    console.log(`No files written. All target files already exist.`);
  }
}
