// Splices `--` and everything after it out of `argv` in place. Returns the
// trailing operands. Commander 13 greedily folds `--`-trailing operands into
// the first declared positional, so we strip them before parsing.
export function spliceDashDashFromArgv(argv: string[]): string[] {
  const idx = argv.indexOf('--');
  if (idx === -1) return [];
  const trailing = argv.slice(idx + 1);
  argv.length = idx;
  return trailing;
}
