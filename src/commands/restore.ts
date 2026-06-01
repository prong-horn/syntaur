import { runRestore, reportArchiveResult, type ArchiveOptions } from './_archive-helper.js';

export async function restoreCommand(target: string, options: ArchiveOptions): Promise<void> {
  const result = await runRestore(target, options);
  reportArchiveResult(result);
}
