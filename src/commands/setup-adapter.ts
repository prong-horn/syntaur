import { resolve } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { fileExists, writeFileReport } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { getAgentTarget, adapterTargets } from '../targets/registry.js';
import { RENDERERS } from '../targets/renderers.js';
import type { ProtocolContext } from '../targets/types.js';

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
  // Resolve the target from the registry. Only targets that expose a Tier-2
  // protocol-instruction adapter are valid here; native-plugin-only agents
  // (e.g. claude) install via the plugin path, not setup-adapter.
  const target = getAgentTarget(framework);
  if (!target || !target.instructions) {
    const supported = adapterTargets()
      .map((t) => t.id)
      .join(', ');
    throw new Error(
      `Unsupported framework "${framework}". Supported: ${supported}`,
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
  const assignmentDir = resolve(projectDir, 'assignments', options.assignment);

  // Verify project exists
  const projectMdPath = resolve(projectDir, 'project.md');
  if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
    throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
  }

  // Verify assignment exists
  const assignmentMdPath = resolve(assignmentDir, 'assignment.md');
  if (
    !(await fileExists(assignmentDir)) ||
    !(await fileExists(assignmentMdPath))
  ) {
    throw new Error(
      `Assignment "${options.assignment}" not found at ${assignmentDir}.`,
    );
  }

  const cwd = process.cwd();
  const rendererParams: ProtocolContext = {
    projectSlug: options.project,
    assignmentSlug: options.assignment,
    projectDir,
    assignmentDir,
  };

  const writtenFiles: string[] = [];
  const upToDateFiles: string[] = [];
  const skippedFiles: string[] = [];

  for (const file of target.instructions.files) {
    const filePath = resolve(cwd, file.path);
    const content = RENDERERS[file.renderer](rendererParams);
    const status = await writeFileReport(filePath, content, {
      force: options.force,
    });
    if (status === 'differs-preserved') {
      skippedFiles.push(filePath);
    } else if (status === 'already-current') {
      upToDateFiles.push(filePath);
    } else {
      // 'written' | 'overwritten'
      writtenFiles.push(filePath);
    }
  }

  // Output results
  if (writtenFiles.length > 0) {
    console.log(`Generated ${target.id} adapter files:`);
    for (const f of writtenFiles) {
      console.log(`  ${f}`);
    }
  }
  if (upToDateFiles.length > 0) {
    console.log(`Already up-to-date:`);
    for (const f of upToDateFiles) {
      console.log(`  ${f}`);
    }
  }
  if (skippedFiles.length > 0) {
    console.log(`Skipped (exists with different content, use --force to overwrite):`);
    for (const f of skippedFiles) {
      console.log(`  ${f}`);
    }
  }
  if (writtenFiles.length === 0 && skippedFiles.length === 0 && upToDateFiles.length > 0) {
    console.log(`No changes. All ${target.id} adapter files are already up-to-date.`);
  }
}
