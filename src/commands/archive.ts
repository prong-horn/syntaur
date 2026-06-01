import { runArchive, reportArchiveResult, type ArchiveOptions } from './_archive-helper.js';

export async function archiveCommand(target: string, options: ArchiveOptions): Promise<void> {
  const result = await runArchive(target, options);
  reportArchiveResult(result);
}
