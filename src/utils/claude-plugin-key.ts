/** True when a Claude Code `enabledPlugins` key refers to the Syntaur plugin (name-only). */
export function isSyntaurPluginKey(key: string): boolean {
  const atIndex = key.lastIndexOf('@');
  const pluginName = atIndex > 0 ? key.slice(0, atIndex) : key;
  return pluginName === 'syntaur';
}
