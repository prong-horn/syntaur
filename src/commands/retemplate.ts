import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { syntaurRoot } from '../utils/paths.js';
import { writeFileForce, fileExists } from '../utils/fs.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { parseTicketFrontmatter, updateTicketFile, updatePlanBlock } from '../lifecycle/frontmatter.js';
import { loadTemplate, resolveTemplateContentDir } from '../ticket-templates/registry.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import {
  scaffoldTemplateFiles,
  scaffoldedPlanPaths,
} from '../ticket-templates/scaffold.js';
import { emitEvent } from '../lifecycle/event-emit.js';

export interface RetemplateOptions {
  project?: string;
  dir?: string;
}

export async function retemplateCommand(
  ticket: string,
  templateId: string,
  options: RetemplateOptions = {},
): Promise<{ written: string[]; from: string; to: string }> {
  const cwd = options.dir ? resolve(options.dir) : process.cwd();
  const target = await resolveTicketTarget(ticket, {
    project: options.project,
    cwd,
  });

  const ticketMdPath = resolve(target.ticketDir, 'ticket.md');
  if (!(await fileExists(ticketMdPath))) {
    throw new Error(`Missing ticket.md at: ${ticketMdPath}`);
  }

  const root = syntaurRoot();
  await seedMissingBuiltins(root);

  let manifest;
  try {
    manifest = await loadTemplate(root, templateId);
  } catch {
    throw new Error(`template ${templateId} not found (syntaur template list)`);
  }

  const ticketContent = await readFile(ticketMdPath, 'utf-8');
  const fm = parseTicketFrontmatter(ticketContent);
  const fromTemplate = fm.template ?? 'legacy';

  const templateDir = await resolveTemplateContentDir(root, templateId);
  const written = await scaffoldTemplateFiles({
    ticketDir: target.ticketDir,
    templateDir,
    template: manifest,
    ticketSlug: target.ticketSlug,
    ticketTitle: fm.title,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ticketStatus: fm.status,
  });

  let nextContent = updateTicketFile(ticketContent, { template: templateId });

  const planWritten = scaffoldedPlanPaths(written, manifest);
  if (planWritten.length > 0) {
    nextContent = updatePlanBlock(nextContent, {
      file: planWritten[0],
      approvedDigest: null,
      approvedAt: null,
      approvedBy: null,
    });
  }

  await writeFileForce(ticketMdPath, nextContent);

  emitEvent({
    ticketId: fm.id,
    projectSlug: target.projectSlug ?? null,
    type: 'retemplated',
    actor: 'human',
    details: { from: fromTemplate, to: templateId, written },
  });

  return { written, from: fromTemplate, to: templateId };
}

export const retemplateCliCommand = new Command('retemplate')
  .description('Switch a ticket to another template and scaffold missing files')
  .argument('<ticket>', 'Ticket id')
  .argument('<template>', 'Template id')
  .option('--project <slug>', 'Project slug when the ticket is project-nested')
  .action(async (ticket: string, template: string, options: RetemplateOptions) => {
    try {
      const result = await retemplateCommand(ticket, template, options);
      console.log(
        `Retemplated ${ticket}: ${result.from} → ${result.to}` +
          (result.written.length > 0 ? ` (wrote ${result.written.join(', ')})` : ''),
      );
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
