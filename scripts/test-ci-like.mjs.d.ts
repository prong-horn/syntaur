export function buildCiLikeEnv(options?: { lookupPath?: string }): {
  env: Record<string, string | undefined>;
  binDir: string;
  homeDir: string;
  jqPath: string;
  npmPath: string;
  npxPath: string;
};
