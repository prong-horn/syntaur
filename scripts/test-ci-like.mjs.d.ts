export function resolveToolPath(
  tool: string,
  lookupPath: string,
  nodeExecPath?: string,
): string;

export function buildCiLikeEnv(options?: {
  lookupPath?: string;
  nodeExecPath?: string;
}): {
  env: Record<string, string | undefined>;
  binDir: string;
  homeDir: string;
  jqPath: string;
  npmPath: string;
  npxPath: string;
};
