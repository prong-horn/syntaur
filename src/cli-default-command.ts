import { isSyntaurDataInstalledSync } from './utils/install.js';

export function getDefaultCommandName(): 'setup' | 'dashboard' {
  return isSyntaurDataInstalledSync() ? 'dashboard' : 'setup';
}
