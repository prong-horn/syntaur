import { isSyntaurDataInstalled } from './utils/install.js';

export async function getDefaultCommandName(): Promise<'init' | 'dashboard'> {
  if (!(await isSyntaurDataInstalled())) {
    return 'init';
  }

  return 'dashboard';
}
