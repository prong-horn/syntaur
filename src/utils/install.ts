import {
  cp,
  symlink,
  lstat,
  readFile,
  readlink,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { readConfig } from './config.js';
import { ensureDir, fileExists } from './fs.js';
import { findPackageRoot } from './package-root.js';
import { expandHome, syntaurRoot } from './paths.js';

export type PluginKind = 'claude' | 'codex';
export type InstallMode = 'copy' | 'link';

const INSTALL_MARKER_FILENAME = '.syntaur-install.json';

interface PackageManifest {
  name: string;
  version: string;
}

interface InstallMetadata {
  packageName: string;
  packageVersion: string;
  pluginKind: PluginKind;
  installMode: InstallMode;
  installedAt: string;
}

export interface ManagedPluginInstallOptions {
  pluginKind: PluginKind;
  force?: boolean;
  link?: boolean;
  targetDir?: string;
}

export interface PluginPaths {
  packageRoot: string;
  sourceDir: string;
  targetDir: string;
}

export interface ManagedPluginInstallResult {
  targetDir: string;
  sourceDir: string;
  mode: InstallMode;
  changed: boolean;
}

export interface MarketplaceEntry {
  name: string;
  source: {
    source: 'local';
    path: string;
  };
  policy: {
    installation: 'AVAILABLE';
    authentication: 'ON_INSTALL';
  };
  category: 'Coding';
}

export interface MarketplaceFile {
  name: string;
  interface?: {
    displayName?: string;
  };
  plugins: MarketplaceEntry[];
}

interface InstallStatus {
  exists: boolean;
  managed: boolean;
  installMode?: InstallMode;
  manifestName?: string;
  symlinkTarget?: string;
}

export interface ManagedInstallInspection {
  exists: boolean;
  managed: boolean;
  installMode?: InstallMode;
  targetDir: string;
}

export interface EnsureMarketplaceEntryOptions {
  marketplacePath: string;
  pluginTargetDir: string;
  expectedExistingPluginTargetDir?: string | null;
}

export interface RemoveMarketplaceEntryOptions {
  marketplacePath: string;
  pluginTargetDir?: string;
  expectedSourcePath?: string | null;
}

function getPluginRelativePath(pluginKind: PluginKind): string {
  return pluginKind === 'claude' ? 'plugin' : 'plugins/syntaur';
}

function getPluginManifestRelativePath(pluginKind: PluginKind): string {
  return pluginKind === 'claude'
    ? '.claude-plugin/plugin.json'
    : '.codex-plugin/plugin.json';
}

export function getDefaultPluginTargetDir(pluginKind: PluginKind): string {
  const home = homedir();
  return pluginKind === 'claude'
    ? resolve(home, '.claude', 'plugins', 'syntaur')
    : resolve(home, 'plugins', 'syntaur');
}

export function getDefaultMarketplacePath(): string {
  return resolve(homedir(), '.agents', 'plugins', 'marketplace.json');
}

function getInstallMarkerPath(targetDir: string): string {
  return resolve(targetDir, INSTALL_MARKER_FILENAME);
}

async function readPackageManifest(packageRoot: string): Promise<PackageManifest> {
  const raw = await readFile(resolve(packageRoot, 'package.json'), 'utf-8');
  return JSON.parse(raw) as PackageManifest;
}

async function readPluginManifestName(
  targetDir: string,
  pluginKind: PluginKind,
): Promise<string | undefined> {
  const manifestPath = resolve(targetDir, getPluginManifestRelativePath(pluginKind));
  if (!(await fileExists(manifestPath))) {
    return undefined;
  }

  const raw = await readFile(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as { name?: string };
  return parsed.name;
}

async function readInstallMetadata(targetDir: string): Promise<InstallMetadata | null> {
  const markerPath = getInstallMarkerPath(targetDir);
  if (!(await fileExists(markerPath))) {
    return null;
  }

  try {
    const raw = await readFile(markerPath, 'utf-8');
    return JSON.parse(raw) as InstallMetadata;
  } catch {
    return null;
  }
}

async function getInstallStatus(
  targetDir: string,
  pluginKind: PluginKind,
): Promise<InstallStatus> {
  if (!(await fileExists(targetDir))) {
    return { exists: false, managed: false };
  }

  const info = await lstat(targetDir);
  if (info.isSymbolicLink()) {
    const symlinkTarget = await readlink(targetDir);
    const resolvedTarget = resolve(dirname(targetDir), symlinkTarget);
    const manifestName = await readPluginManifestName(resolvedTarget, pluginKind);
    return {
      exists: true,
      managed: manifestName === 'syntaur',
      installMode: 'link',
      manifestName,
      symlinkTarget: resolvedTarget,
    };
  }

  const metadata = await readInstallMetadata(targetDir);
  const manifestName = await readPluginManifestName(targetDir, pluginKind);
  return {
    exists: true,
    managed: Boolean(
      (metadata && metadata.pluginKind === pluginKind && metadata.packageName === 'syntaur') ||
        manifestName === 'syntaur',
    ),
    installMode: metadata?.installMode ?? 'copy',
    manifestName,
  };
}

async function writeInstallMetadata(
  targetDir: string,
  pluginKind: PluginKind,
  installMode: InstallMode,
  packageManifest: PackageManifest,
): Promise<void> {
  const metadata: InstallMetadata = {
    packageName: packageManifest.name,
    packageVersion: packageManifest.version,
    pluginKind,
    installMode,
    installedAt: new Date().toISOString(),
  };

  await writeFile(
    getInstallMarkerPath(targetDir),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf-8',
  );
}

async function installCopy(
  paths: PluginPaths,
  pluginKind: PluginKind,
): Promise<void> {
  await ensureDir(dirname(paths.targetDir));
  await cp(paths.sourceDir, paths.targetDir, { recursive: true });
  const packageManifest = await readPackageManifest(paths.packageRoot);
  await writeInstallMetadata(paths.targetDir, pluginKind, 'copy', packageManifest);
}

async function installLink(paths: PluginPaths): Promise<void> {
  await ensureDir(dirname(paths.targetDir));
  await rm(paths.targetDir, { recursive: true, force: true });
  await ensureDir(dirname(paths.targetDir));
  await symlink(resolve(paths.sourceDir), paths.targetDir, 'dir');
}

async function removeInstallMarker(targetDir: string): Promise<void> {
  const markerPath = getInstallMarkerPath(targetDir);
  if (await fileExists(markerPath)) {
    await unlink(markerPath).catch(() => {});
  }
}

export function normalizeAbsoluteInstallPath(pathValue: string, label: string): string {
  const expanded = expandHome(pathValue.trim());
  if (!isAbsolute(expanded)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return resolve(expanded);
}

export async function resolvePluginPaths(
  pluginKind: PluginKind,
  targetDir?: string,
): Promise<PluginPaths> {
  const packageRoot = await findPackageRoot(getPluginRelativePath(pluginKind));
  return {
    packageRoot,
    sourceDir: resolve(packageRoot, getPluginRelativePath(pluginKind)),
    targetDir: targetDir ?? getDefaultPluginTargetDir(pluginKind),
  };
}

export async function inspectInstallPath(
  pluginKind: PluginKind,
  targetDir: string,
): Promise<ManagedInstallInspection> {
  const normalizedTarget = normalizeAbsoluteInstallPath(targetDir, `${getPluginDisplayName(pluginKind)} target`);
  const status = await getInstallStatus(normalizedTarget, pluginKind);
  return {
    exists: status.exists,
    managed: status.managed,
    installMode: status.installMode,
    targetDir: normalizedTarget,
  };
}

export async function installManagedPlugin(
  options: ManagedPluginInstallOptions,
): Promise<ManagedPluginInstallResult> {
  const {
    pluginKind,
    force = false,
    link = false,
    targetDir = getDefaultPluginTargetDir(pluginKind),
  } = options;
  const normalizedTargetDir = normalizeAbsoluteInstallPath(
    targetDir,
    `${getPluginDisplayName(pluginKind)} target`,
  );
  const paths = await resolvePluginPaths(pluginKind, normalizedTargetDir);

  if (!(await fileExists(paths.sourceDir))) {
    throw new Error(`Plugin source directory not found at ${paths.sourceDir}.`);
  }

  const desiredMode: InstallMode = link ? 'link' : 'copy';
  const existing = await getInstallStatus(paths.targetDir, pluginKind);

  if (existing.exists && !existing.managed) {
    throw new Error(
      `${paths.targetDir} already exists and is not a Syntaur-managed install. Remove it manually before installing Syntaur there.`,
    );
  }

  if (
    desiredMode === 'link' &&
    existing.exists &&
    existing.installMode === 'link' &&
    existing.symlinkTarget === resolve(paths.sourceDir) &&
    !force
  ) {
    return {
      targetDir: paths.targetDir,
      sourceDir: paths.sourceDir,
      mode: desiredMode,
      changed: false,
    };
  }

  if (existing.exists) {
    await rm(paths.targetDir, { recursive: true, force: true });
  }

  if (desiredMode === 'link') {
    await installLink(paths);
  } else {
    await installCopy(paths, pluginKind);
  }

  return {
    targetDir: paths.targetDir,
    sourceDir: paths.sourceDir,
    mode: desiredMode,
    changed: true,
  };
}

export function buildMarketplaceSourcePath(
  pluginTargetDir: string,
  marketplacePath: string,
): string {
  const relPath = relative(dirname(marketplacePath), pluginTargetDir).replaceAll('\\', '/');
  if (relPath === '') {
    return '.';
  }
  return relPath.startsWith('.') ? relPath : `./${relPath}`;
}

export function buildSyntaurMarketplaceEntry(
  pluginTargetDir: string,
  marketplacePath: string,
): MarketplaceEntry {
  return {
    name: 'syntaur',
    source: {
      source: 'local',
      path: buildMarketplaceSourcePath(pluginTargetDir, marketplacePath),
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Coding',
  };
}

export async function readMarketplaceFile(marketplacePath: string): Promise<MarketplaceFile> {
  if (!(await fileExists(marketplacePath))) {
    return {
      name: 'local',
      interface: { displayName: 'Local Plugins' },
      plugins: [],
    };
  }

  const raw = await readFile(marketplacePath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<MarketplaceFile>;
  return {
    name: parsed.name ?? 'local',
    interface: parsed.interface ?? { displayName: 'Local Plugins' },
    plugins: Array.isArray(parsed.plugins)
      ? (parsed.plugins as MarketplaceEntry[])
      : [],
  };
}

export async function writeMarketplaceFile(
  marketplacePath: string,
  marketplace: MarketplaceFile,
): Promise<void> {
  await ensureDir(dirname(marketplacePath));
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf-8');
}

export async function hasAnySyntaurMarketplaceEntry(marketplacePath: string): Promise<boolean> {
  const marketplace = await readMarketplaceFile(marketplacePath);
  return marketplace.plugins.some(
    (plugin) => plugin.name === 'syntaur' && plugin.source?.source === 'local',
  );
}

export async function hasSyntaurMarketplaceEntry(
  marketplacePath: string,
  pluginTargetDir: string,
): Promise<boolean> {
  const marketplace = await readMarketplaceFile(marketplacePath);
  const expectedPath = buildMarketplaceSourcePath(pluginTargetDir, marketplacePath);
  return marketplace.plugins.some(
    (plugin) =>
      plugin.name === 'syntaur' &&
      plugin.source?.source === 'local' &&
      plugin.source?.path === expectedPath,
  );
}

export async function ensureMarketplaceEntry(
  options: EnsureMarketplaceEntryOptions,
): Promise<{ marketplacePath: string; changed: boolean }> {
  const marketplacePath = normalizeAbsoluteInstallPath(
    options.marketplacePath,
    'Codex marketplace path',
  );
  const pluginTargetDir = normalizeAbsoluteInstallPath(
    options.pluginTargetDir,
    'Codex plugin target',
  );
  const marketplace = await readMarketplaceFile(marketplacePath);
  const entry = buildSyntaurMarketplaceEntry(pluginTargetDir, marketplacePath);
  const existingIndex = marketplace.plugins.findIndex(
    (plugin) =>
      plugin.name === entry.name &&
      plugin.source?.source === entry.source.source &&
      plugin.source?.path === entry.source.path,
  );

  if (existingIndex >= 0) {
    return { marketplacePath, changed: false };
  }

  const conflictingIndex = marketplace.plugins.findIndex((plugin) => plugin.name === entry.name);
  if (conflictingIndex >= 0) {
    const existing = marketplace.plugins[conflictingIndex];
    const expectedExistingPath = options.expectedExistingPluginTargetDir
      ? buildMarketplaceSourcePath(
          normalizeAbsoluteInstallPath(
            options.expectedExistingPluginTargetDir,
            'Existing Codex plugin target',
          ),
          marketplacePath,
        )
      : null;

    if (
      existing.source?.source === 'local' &&
      expectedExistingPath &&
      existing.source?.path === expectedExistingPath
    ) {
      marketplace.plugins[conflictingIndex] = entry;
      await writeMarketplaceFile(marketplacePath, marketplace);
      return { marketplacePath, changed: true };
    }

    throw new Error(
      `Marketplace entry "${entry.name}" already exists with different settings in ${marketplacePath}. Remove it manually before installing the Codex plugin.`,
    );
  }

  marketplace.plugins.push(entry);
  await writeMarketplaceFile(marketplacePath, marketplace);
  return { marketplacePath, changed: true };
}

function isDefaultMarketplaceShell(marketplace: MarketplaceFile): boolean {
  return (
    marketplace.name === 'local' &&
    (marketplace.interface?.displayName ?? 'Local Plugins') === 'Local Plugins'
  );
}

export async function removeMarketplaceEntry(
  options: RemoveMarketplaceEntryOptions,
): Promise<{ marketplacePath: string; removed: boolean }> {
  const marketplacePath = normalizeAbsoluteInstallPath(
    options.marketplacePath,
    'Codex marketplace path',
  );

  if (!(await fileExists(marketplacePath))) {
    return { marketplacePath, removed: false };
  }

  const expectedSourcePath = options.expectedSourcePath ?? (
    options.pluginTargetDir
      ? buildMarketplaceSourcePath(
          normalizeAbsoluteInstallPath(options.pluginTargetDir, 'Codex plugin target'),
          marketplacePath,
        )
      : null
  );
  const marketplace = await readMarketplaceFile(marketplacePath);
  const beforeCount = marketplace.plugins.length;
  marketplace.plugins = marketplace.plugins.filter((plugin) => {
    if (plugin.name !== 'syntaur' || plugin.source?.source !== 'local') {
      return true;
    }
    if (!expectedSourcePath) {
      return false;
    }
    return plugin.source.path !== expectedSourcePath;
  });

  if (marketplace.plugins.length === beforeCount) {
    return { marketplacePath, removed: false };
  }

  if (marketplace.plugins.length === 0 && isDefaultMarketplaceShell(marketplace)) {
    await rm(marketplacePath, { force: true });
    return { marketplacePath, removed: true };
  }

  await writeMarketplaceFile(marketplacePath, marketplace);
  return { marketplacePath, removed: true };
}

export async function uninstallManagedPlugin(
  pluginKind: PluginKind,
  targetDir: string = getDefaultPluginTargetDir(pluginKind),
): Promise<{ removed: boolean; targetDir: string }> {
  const normalizedTarget = normalizeAbsoluteInstallPath(
    targetDir,
    `${getPluginDisplayName(pluginKind)} target`,
  );
  const existing = await getInstallStatus(normalizedTarget, pluginKind);

  if (!existing.exists) {
    return { removed: false, targetDir: normalizedTarget };
  }

  if (!existing.managed) {
    throw new Error(
      `${normalizedTarget} exists but is not a Syntaur-managed install. Remove it manually if you want to replace it.`,
    );
  }

  await removeInstallMarker(normalizedTarget);
  await rm(normalizedTarget, { recursive: true, force: true });
  return { removed: true, targetDir: normalizedTarget };
}

export async function getConfiguredOrLegacyManagedPluginDir(
  pluginKind: PluginKind,
): Promise<string | null> {
  const config = await readConfig();
  const configuredPath = pluginKind === 'claude'
    ? config.integrations.claudePluginDir
    : config.integrations.codexPluginDir;
  if (configuredPath) {
    return configuredPath;
  }

  const defaultTarget = getDefaultPluginTargetDir(pluginKind);
  const status = await getInstallStatus(defaultTarget, pluginKind);
  return status.exists && status.managed ? defaultTarget : null;
}

export async function getConfiguredOrLegacyMarketplacePath(): Promise<string | null> {
  const config = await readConfig();
  if (config.integrations.codexMarketplacePath) {
    return config.integrations.codexMarketplacePath;
  }

  const defaultMarketplacePath = getDefaultMarketplacePath();
  return (await hasAnySyntaurMarketplaceEntry(defaultMarketplacePath))
    ? defaultMarketplacePath
    : null;
}

export async function recommendPluginTargetDir(pluginKind: PluginKind): Promise<string> {
  const configuredOrManaged = await getConfiguredOrLegacyManagedPluginDir(pluginKind);
  return configuredOrManaged ?? getDefaultPluginTargetDir(pluginKind);
}

export async function recommendMarketplacePath(): Promise<string> {
  const configuredOrManaged = await getConfiguredOrLegacyMarketplacePath();
  return configuredOrManaged ?? getDefaultMarketplacePath();
}

export async function isSyntaurDataInstalled(): Promise<boolean> {
  return fileExists(resolve(syntaurRoot(), 'config.md'));
}

export function isSyntaurDataInstalledSync(): boolean {
  return existsSync(resolve(syntaurRoot(), 'config.md'));
}

export async function removeSyntaurData(): Promise<void> {
  await rm(syntaurRoot(), { recursive: true, force: true });
}

export async function getConfiguredMissionDir(): Promise<string | null> {
  if (!(await fileExists(resolve(syntaurRoot(), 'config.md')))) {
    return null;
  }

  return (await readConfig()).defaultMissionDir;
}

export function getPluginDisplayName(pluginKind: PluginKind): string {
  return pluginKind === 'claude' ? 'Claude Code plugin' : 'Codex plugin';
}

export function getPluginInstallCommand(pluginKind: PluginKind): string {
  return pluginKind === 'claude'
    ? 'syntaur install-plugin'
    : 'syntaur install-codex-plugin';
}

export function getPluginTargetLabel(pluginKind: PluginKind): string {
  return basename(getDefaultPluginTargetDir(pluginKind));
}
