import { resolve } from 'node:path';
import { expandHome } from '../utils/paths.js';
import { fileExists, writeFileReport } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { isValidSlug } from '../utils/slug.js';
import { resolveAgentTargets } from '../targets/registry.js';
import { RENDERERS } from '../targets/renderers.js';
import type { ProtocolContext } from '../targets/types.js';

export interface SetupAdapterOptions {
  project: string;
  ticket: string;
  force?: boolean;
  dir?: string;
}

export async function setupAdapterCommand(
  framework: string,
  options: SetupAdapterOptions,
): Promise<void> {
  // Resolve the target from the registry (built-ins + user descriptors). Only
  // targets that expose a Tier-2 protocol-instruction adapter are valid here;
  // native-plugin-only agents (e.g. claude) install via the plugin path.
  const { targets: known, warnings } = await resolveAgentTargets();
  const target = known.find((t) => t.id === framework);
  if (!target || !target.instructions) {
    const supported = known
      .filter((t) => t.instructions !== undefined)
      .map((t) => t.id)
      .join(', ');
    // Surface loader warnings so a malformed user descriptor (which is why a
    // just-added id can be "unsupported") shows its validation reason.
    const warn = warnings.length ? ` (descriptor warnings: ${warnings.join('; ')})` : '';
    throw new Error(
      `Unsupported framework "${framework}". Supported: ${supported}.${warn}`,
    );
  }

  // Validate required options
  if (!options.project) {
    throw new Error('--project <slug> is required.');
  }
  if (!options.ticket) {
    throw new Error('--ticket <slug> is required.');
  }
  if (!isValidSlug(options.project)) {
    throw new Error(
      `Invalid project slug "${options.project}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }
  if (!isValidSlug(options.ticket)) {
    throw new Error(
      `Invalid ticket slug "${options.ticket}". Slugs must be lowercase, hyphen-separated, with no special characters.`,
    );
  }

  // Resolve paths
  const config = await readConfig();
  const baseDir = options.dir
    ? expandHome(options.dir)
    : config.defaultProjectDir;
  const projectDir = resolve(baseDir, options.project);
  const ticketDir = resolve(projectDir, 'tickets', options.ticket);

  // Verify project exists
  const projectMdPath = resolve(projectDir, 'project.md');
  if (!(await fileExists(projectDir)) || !(await fileExists(projectMdPath))) {
    throw new Error(`Project "${options.project}" not found at ${projectDir}.`);
  }

  // Verify ticket exists
  const assignmentMdPath = resolve(ticketDir, 'ticket.md');
  if (
    !(await fileExists(ticketDir)) ||
    !(await fileExists(assignmentMdPath))
  ) {
    throw new Error(
      `Ticket "${options.ticket}" not found at ${ticketDir}.`,
    );
  }

  const cwd = process.cwd();
  const rendererParams: ProtocolContext = {
    projectSlug: options.project,
    ticketSlug: options.ticket,
    projectDir,
    ticketDir,
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
