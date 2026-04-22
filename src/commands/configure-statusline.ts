import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkbox, input, confirm } from '@inquirer/prompts';
import { syntaurRoot } from '../utils/paths.js';
import { ensureDir, fileExists } from '../utils/fs.js';
import { isInteractiveTerminal } from '../utils/prompt.js';

export type SegmentName = 'wrap' | 'git' | 'assignment' | 'external' | 'session' | 'model' | 'ctx' | 'cwd';

export const AVAILABLE_SEGMENTS: ReadonlyArray<{ name: SegmentName; preview: string; description: string }> =
  [
    { name: 'git',        preview: 'syntaur:main* +2',                         description: 'repo:branch (with dirty marker and ahead/behind)' },
    { name: 'assignment', preview: 'my-proj/demo-assn — Demo Assignment',      description: 'active syntaur assignment (project/slug or standalone/uuid)' },
    { name: 'external',   preview: 'PROJ-123, ENG-456',                        description: 'external tracker IDs from assignment externalIds (Jira, Linear, …)' },
    { name: 'session',    preview: '9c3a4d2e-1b7f-4a0c-bb11-ccddeeff0011',     description: 'Claude Code session id (full)' },
    { name: 'model',      preview: 'Opus 4.7',                                 description: 'Claude model display name' },
    { name: 'ctx',        preview: 'ctx:[####------] 42%',                     description: 'context window fill bar' },
    { name: 'cwd',        preview: 'syntaur',                                  description: 'basename of current working directory' },
    { name: 'wrap',       preview: '<output of an external script>',           description: 'compose another statusline script as a leading segment' },
  ];

export const PRESETS: Record<string, { segments: SegmentName[]; separator: string }> = {
  minimal: { segments: ['git', 'session'], separator: ' · ' },
  syntaur: { segments: ['git', 'assignment', 'session'], separator: ' · ' },
  full:    { segments: ['wrap', 'git', 'assignment', 'external', 'model', 'ctx', 'session'], separator: ' · ' },
  dev:     { segments: ['git', 'assignment', 'external', 'ctx', 'session'], separator: ' · ' },
  tracker: { segments: ['git', 'assignment', 'external', 'session'], separator: ' · ' },
};

export interface StatuslineConfig {
  segments: SegmentName[];
  separator: string;
  wrap?: string;
}

export interface ConfigureStatuslineOptions {
  preset?: string;
  segments?: string;      // comma-separated
  separator?: string;
  wrap?: string;
  preview?: boolean;
  installRoot?: string;
  statuslineScript?: string; // override for tests
}

function getConfigPath(installRoot: string): string {
  return resolve(installRoot, 'statusline.config.json');
}

async function readConfig(path: string): Promise<StatuslineConfig | null> {
  if (!(await fileExists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const segments = Array.isArray(parsed.segments) ? parsed.segments.filter(isSegmentName) : [];
    const separator = typeof parsed.separator === 'string' ? parsed.separator : ' · ';
    const wrap = typeof parsed.wrap === 'string' ? parsed.wrap : undefined;
    return { segments, separator, wrap };
  } catch {
    return null;
  }
}

function isSegmentName(value: unknown): value is SegmentName {
  return typeof value === 'string' && AVAILABLE_SEGMENTS.some((s) => s.name === value);
}

function parseSegmentsFlag(flag: string): SegmentName[] {
  const parts = flag.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = parts.filter((p) => !AVAILABLE_SEGMENTS.some((s) => s.name === p));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown segment${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}. ` +
        `Valid segments: ${AVAILABLE_SEGMENTS.map((s) => s.name).join(', ')}.`,
    );
  }
  return parts as SegmentName[];
}

async function promptSegmentsInteractive(
  current: StatuslineConfig | null,
): Promise<{ segments: SegmentName[]; separator: string; wrap?: string }> {
  // Canonical left-to-right order shown in the checkbox. The returned array
  // from `checkbox()` preserves this order regardless of which keys users hit,
  // which matches the most common reading-order preference.
  const canonicalOrder: SegmentName[] = ['wrap', 'git', 'assignment', 'external', 'session', 'model', 'ctx', 'cwd'];

  const selectedSet = new Set(current?.segments ?? ['git', 'assignment', 'session']);
  const choices = canonicalOrder.map((name) => {
    const def = AVAILABLE_SEGMENTS.find((s) => s.name === name)!;
    return {
      name: `${def.name.padEnd(11)} ${def.description}`,
      value: name,
      checked: selectedSet.has(name),
      description: `preview: ${def.preview}`,
    };
  });

  const selected = (await checkbox({
    message: 'Pick segments (space to toggle, enter to confirm):',
    choices,
    loop: false,
    pageSize: choices.length,
    required: true,
  })) as SegmentName[];

  // Ask whether to customize the canonical order. Most users will say no.
  const defaultReorderHint = selected.join(', ');
  let orderedSegments: SegmentName[] = [...selected];
  const wantReorder = await confirm({
    message: `Order will be: ${defaultReorderHint}. Customize order?`,
    default: false,
  });
  if (wantReorder) {
    const raw = await input({
      message: `Enter the segments in the order you want, comma-separated:`,
      default: defaultReorderHint,
      validate: (value) => {
        const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
        const invalid = parts.filter((p) => !canonicalOrder.includes(p as SegmentName));
        if (invalid.length > 0) {
          return `Unknown: ${invalid.join(', ')}. Valid: ${canonicalOrder.join(', ')}.`;
        }
        const missing = selected.filter((s) => !parts.includes(s));
        if (missing.length > 0) {
          return `Missing previously-selected segment(s): ${missing.join(', ')}. Include all of them or go back.`;
        }
        return true;
      },
    });
    orderedSegments = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as SegmentName[];
  }

  const separator = await input({
    message: 'Separator between segments:',
    default: current?.separator ?? ' · ',
  });

  let wrap: string | undefined = current?.wrap;
  if (orderedSegments.includes('wrap')) {
    wrap = await input({
      message: 'Path to external script to wrap (leave blank to skip):',
      default: current?.wrap ?? '',
    });
    wrap = wrap.trim() ? wrap.trim() : undefined;
  }

  return { segments: orderedSegments, separator, wrap };
}

function renderPreview(
  config: StatuslineConfig,
  statuslineScript: string,
  cwd: string,
): string | null {
  const payload = {
    session_id: 'preview-demo-0000000000abcdef12',
    cwd,
    model: { display_name: 'Opus 4.7' },
    context_window: { used_percentage: 42 },
  };
  const res = spawnSync('bash', [statuslineScript], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Force the child to pick up the freshly-written config from install root.
      HOME: dirname(dirname(statuslineScript)),
    },
  });
  if (res.status !== 0) return null;
  return res.stdout;
}

export async function configureStatuslineCommand(
  options: ConfigureStatuslineOptions = {},
): Promise<void> {
  const installRoot = options.installRoot ?? syntaurRoot();
  const configPath = getConfigPath(installRoot);
  const current = await readConfig(configPath);

  let segments: SegmentName[];
  let separator: string;
  let wrap: string | undefined;

  if (options.preset) {
    const preset = PRESETS[options.preset.toLowerCase()];
    if (!preset) {
      throw new Error(
        `Unknown preset "${options.preset}". Presets: ${Object.keys(PRESETS).join(', ')}.`,
      );
    }
    segments = [...preset.segments];
    separator = options.separator ?? preset.separator;
    wrap = options.wrap ?? current?.wrap;
  } else if (options.segments) {
    segments = parseSegmentsFlag(options.segments);
    separator = options.separator ?? current?.separator ?? ' · ';
    wrap = options.wrap ?? current?.wrap;
  } else if (isInteractiveTerminal()) {
    const answers = await promptSegmentsInteractive(current);
    segments = answers.segments;
    separator = answers.separator;
    wrap = answers.wrap;
  } else {
    throw new Error(
      'Non-interactive invocation requires --preset, --segments, or run in a TTY.',
    );
  }

  // If 'wrap' selected but no path configured, warn (don't block).
  if (segments.includes('wrap') && !wrap) {
    console.warn(
      'Note: the "wrap" segment is selected but no wrap path is configured. ' +
        'Set one with --wrap <path> or edit ' +
        `${configPath} afterwards.`,
    );
  }

  const config: StatuslineConfig = { segments, separator, ...(wrap ? { wrap } : {}) };

  // Preview mode: don't write.
  if (options.preview) {
    console.log('Segments:  ' + config.segments.join(', '));
    console.log('Separator: ' + JSON.stringify(config.separator));
    if (config.wrap) console.log('Wrap:      ' + config.wrap);
    console.log('');
    console.log('(preview mode — config NOT written)');
    return;
  }

  await ensureDir(dirname(configPath));
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log('Wrote statusline config:');
  console.log(`  path:      ${configPath}`);
  console.log(`  segments:  ${config.segments.join(', ')}`);
  console.log(`  separator: ${JSON.stringify(config.separator)}`);
  if (config.wrap) console.log(`  wrap:      ${config.wrap}`);

  // Render a preview line so the user sees what they just configured.
  const script = options.statuslineScript ?? resolve(installRoot, 'statusline.sh');
  if (await fileExists(script)) {
    console.log('');
    console.log('Live preview:');
    const out = renderPreview(config, script, process.cwd());
    if (out) {
      console.log('  ' + out);
    } else {
      console.log('  (preview failed — run `syntaur install-statusline` if the script is missing)');
    }
  } else {
    console.log('');
    console.log(
      '(statusline script not yet installed — run `syntaur install-statusline` to wire it up)',
    );
  }
}

// --- Exported for install-statusline integration ---

export async function writeDefaultConfigIfMissing(installRoot: string): Promise<void> {
  const path = getConfigPath(installRoot);
  if (await fileExists(path)) return;
  await ensureDir(dirname(path));
  const defaultConfig: StatuslineConfig = {
    segments: ['git', 'assignment', 'session'],
    separator: ' · ',
  };
  await writeFile(path, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8');
}
