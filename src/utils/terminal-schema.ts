export type TerminalChoice =
  | 'terminal-app'
  | 'iterm'
  | 'ghostty'
  | 'alacritty'
  | 'warp'
  | 'kitty'
  | 'cmux';

export const TERMINAL_CHOICES: readonly TerminalChoice[] = [
  'terminal-app',
  'iterm',
  'ghostty',
  'alacritty',
  'warp',
  'kitty',
  'cmux',
];
