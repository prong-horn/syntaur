import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { syntaurRoot, defaultMissionDir, expandHome } from './paths.js';
import { fileExists } from './fs.js';

export interface SyntaurConfig {
  version: string;
  defaultMissionDir: string;
  agentDefaults: {
    trustLevel: 'low' | 'medium' | 'high';
    autoApprove: boolean;
  };
}

const DEFAULT_CONFIG: SyntaurConfig = {
  version: '1.0',
  defaultMissionDir: defaultMissionDir(),
  agentDefaults: {
    trustLevel: 'medium',
    autoApprove: false,
  },
};

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  const lines = match[1].split('\n');
  let currentParent: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (indent === 0) {
      if (value === '' || value === undefined) {
        currentParent = key;
      } else {
        currentParent = null;
        result[key] = value.replace(/^["']|["']$/g, '');
      }
    } else if (indent > 0 && currentParent) {
      result[`${currentParent}.${key}`] = value.replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

export async function readConfig(): Promise<SyntaurConfig> {
  const configPath = resolve(syntaurRoot(), 'config.md');
  if (!(await fileExists(configPath))) {
    return { ...DEFAULT_CONFIG };
  }
  const content = await readFile(configPath, 'utf-8');
  const fm = parseFrontmatter(content);

  if (Object.keys(fm).length === 0) {
    console.warn('Warning: ~/.syntaur/config.md has malformed frontmatter, using defaults');
    return { ...DEFAULT_CONFIG };
  }

  let missionDir = fm['defaultMissionDir']
    ? expandHome(String(fm['defaultMissionDir']))
    : DEFAULT_CONFIG.defaultMissionDir;
  if (!isAbsolute(missionDir)) {
    console.warn(
      `Warning: config.md defaultMissionDir is not an absolute path ("${fm['defaultMissionDir']}"), using default`,
    );
    missionDir = DEFAULT_CONFIG.defaultMissionDir;
  }

  return {
    version: fm['version'] || DEFAULT_CONFIG.version,
    defaultMissionDir: missionDir,
    agentDefaults: {
      trustLevel:
        (fm['agentDefaults.trustLevel'] as SyntaurConfig['agentDefaults']['trustLevel']) ||
        DEFAULT_CONFIG.agentDefaults.trustLevel,
      autoApprove:
        fm['agentDefaults.autoApprove'] === 'true' ||
        DEFAULT_CONFIG.agentDefaults.autoApprove,
    },
  };
}
