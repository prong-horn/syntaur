import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  readConfig,
  updatePlaybooksConfig,
  type SyntaurConfig,
} from '../utils/config.js';
import {
  setPlaybookEnabled,
  loadEnabledPlaybook,
  resolvePlaybookSlug,
  removeFromDisabledList,
  rebuildPlaybookManifest,
} from '../utils/playbooks.js';
import { enablePlaybookCommand } from '../commands/enable-playbook.js';
import { disablePlaybookCommand } from '../commands/disable-playbook.js';
import { listPlaybooks, getPlaybookDetail } from '../dashboard/api.js';
import { createPlaybooksRouter } from '../dashboard/api-playbooks.js';

let sandbox: string;
let prevHome: string | undefined;
let playbooksDir: string;

function playbookContents(slug: string, name: string, frontmatterSlug?: string): string {
  return [
    '---',
    `name: "${name}"`,
    `slug: ${frontmatterSlug ?? slug}`,
    'description: "test playbook"',
    'when_to_use: "always"',
    'created: "2026-04-25T00:00:00Z"',
    'updated: "2026-04-25T00:00:00Z"',
    'tags: []',
    '---',
    '',
    `# ${name}`,
    '',
    'body',
    '',
  ].join('\n');
}

async function writePlaybook(slug: string, name = slug, frontmatterSlug?: string): Promise<void> {
  await writeFile(
    resolve(playbooksDir, `${slug}.md`),
    playbookContents(slug, name, frontmatterSlug),
    'utf-8',
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-playbook-toggle-'));
  prevHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = resolve(sandbox, '.syntaur');
  playbooksDir = resolve(process.env.SYNTAUR_HOME, 'playbooks');
  await mkdir(playbooksDir, { recursive: true });
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = prevHome;
  await rm(sandbox, { recursive: true, force: true });
});

describe('config: playbooks.disabled', () => {
  it('round-trips through updatePlaybooksConfig and readConfig', async () => {
    await updatePlaybooksConfig({ disabled: ['foo', 'bar'] });
    const cfg = await readConfig();
    expect(cfg.playbooks.disabled.sort()).toEqual(['bar', 'foo']);
  });

  it('strips the playbooks block when disabled is empty', async () => {
    await updatePlaybooksConfig({ disabled: ['foo'] });
    await updatePlaybooksConfig({ disabled: [] });
    const cfg = await readConfig();
    expect(cfg.playbooks.disabled).toEqual([]);
    const raw = await readFile(resolve(process.env.SYNTAUR_HOME!, 'config.md'), 'utf-8');
    expect(raw).not.toContain('playbooks:');
  });

  it('dedupes disabled entries', async () => {
    await updatePlaybooksConfig({ disabled: ['foo', 'foo', 'bar', 'foo'] });
    const cfg = await readConfig();
    expect(cfg.playbooks.disabled.sort()).toEqual(['bar', 'foo']);
  });

  it('returns isolated default arrays so callers cannot mutate DEFAULT_CONFIG', async () => {
    const a: SyntaurConfig = await readConfig();
    a.playbooks.disabled.push('mutation-test');
    const b: SyntaurConfig = await readConfig();
    expect(b.playbooks.disabled).toEqual([]);
  });
});

describe('resolvePlaybookSlug', () => {
  it('resolves by frontmatter slug when filename and frontmatter agree', async () => {
    await writePlaybook('foo');
    const r = await resolvePlaybookSlug(playbooksDir, 'foo');
    expect(r).not.toBeNull();
    expect(r!.slug).toBe('foo');
    expect(r!.filename).toBe('foo.md');
  });

  it('resolves by frontmatter slug even when filename differs', async () => {
    await writePlaybook('filename-stem', 'Mismatch', 'canonical-bar');
    const byFrontmatter = await resolvePlaybookSlug(playbooksDir, 'canonical-bar');
    expect(byFrontmatter?.slug).toBe('canonical-bar');
    expect(byFrontmatter?.filename).toBe('filename-stem.md');

    const byFilename = await resolvePlaybookSlug(playbooksDir, 'filename-stem');
    expect(byFilename).toBeNull();
  });

  it('falls back to filename stem when frontmatter slug is missing', async () => {
    const noSlugContent = [
      '---',
      'name: "Headless"',
      'description: ""',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    await writeFile(resolve(playbooksDir, 'headless.md'), noSlugContent, 'utf-8');
    const r = await resolvePlaybookSlug(playbooksDir, 'headless');
    expect(r?.filename).toBe('headless.md');
  });
});

describe('setPlaybookEnabled + manifest filter', () => {
  it('excludes disabled playbooks from rebuilt manifest and reflects in total', async () => {
    await writePlaybook('alpha');
    await writePlaybook('beta');

    await setPlaybookEnabled(playbooksDir, 'alpha', false);

    const manifest = await readFile(resolve(playbooksDir, 'manifest.md'), 'utf-8');
    expect(manifest).toContain('total: 1');
    expect(manifest).not.toMatch(/\[alpha\]/);
    expect(manifest).toContain('beta.md');
  });

  it('is idempotent — repeated disable/enable do not duplicate state', async () => {
    await writePlaybook('alpha');

    const first = await setPlaybookEnabled(playbooksDir, 'alpha', false);
    expect(first.changed).toBe(true);

    const second = await setPlaybookEnabled(playbooksDir, 'alpha', false);
    expect(second.changed).toBe(false);

    const cfg = await readConfig();
    expect(cfg.playbooks.disabled).toEqual(['alpha']);
  });

  it('throws when the slug cannot be resolved', async () => {
    await expect(setPlaybookEnabled(playbooksDir, 'does-not-exist', false)).rejects.toThrow(
      /not found/,
    );
  });
});

describe('loadEnabledPlaybook', () => {
  it('returns the parsed playbook when enabled', async () => {
    await writePlaybook('alpha', 'Alpha');
    const p = await loadEnabledPlaybook(playbooksDir, 'alpha');
    expect(p?.name).toBe('Alpha');
  });

  it('returns null when the playbook is disabled', async () => {
    await writePlaybook('alpha');
    await setPlaybookEnabled(playbooksDir, 'alpha', false);
    const p = await loadEnabledPlaybook(playbooksDir, 'alpha');
    expect(p).toBeNull();
  });

  it('returns null when the playbook does not exist', async () => {
    expect(await loadEnabledPlaybook(playbooksDir, 'missing')).toBeNull();
  });
});

describe('removeFromDisabledList', () => {
  it('scrubs a slug from the disabled list', async () => {
    await writePlaybook('alpha');
    await setPlaybookEnabled(playbooksDir, 'alpha', false);
    await removeFromDisabledList('alpha');
    const cfg = await readConfig();
    expect(cfg.playbooks.disabled).toEqual([]);
  });

  it('is a no-op when the slug is not disabled', async () => {
    await removeFromDisabledList('never-disabled');
    const cfg = await readConfig();
    expect(cfg.playbooks.disabled).toEqual([]);
  });
});

describe('CLI commands', () => {
  it('disablePlaybookCommand disables and is idempotent', async () => {
    await writePlaybook('alpha');
    await disablePlaybookCommand('alpha');
    const cfg1 = await readConfig();
    expect(cfg1.playbooks.disabled).toEqual(['alpha']);

    await disablePlaybookCommand('alpha');
    const cfg2 = await readConfig();
    expect(cfg2.playbooks.disabled).toEqual(['alpha']);
  });

  it('enablePlaybookCommand re-enables and is idempotent', async () => {
    await writePlaybook('alpha');
    await disablePlaybookCommand('alpha');
    await enablePlaybookCommand('alpha');
    const cfg1 = await readConfig();
    expect(cfg1.playbooks.disabled).toEqual([]);

    await enablePlaybookCommand('alpha');
    const cfg2 = await readConfig();
    expect(cfg2.playbooks.disabled).toEqual([]);
  });

  it('throws on unknown slug', async () => {
    await expect(disablePlaybookCommand('not-a-real-slug')).rejects.toThrow(/not found/);
  });

  it('rejects invalid slug format', async () => {
    await expect(disablePlaybookCommand('Bad Slug!')).rejects.toThrow(/Invalid slug/);
  });
});

describe('dashboard listPlaybooks + getPlaybookDetail', () => {
  it('lists disabled playbooks with enabled: false and never filters them out', async () => {
    await writePlaybook('alpha');
    await writePlaybook('beta');
    await setPlaybookEnabled(playbooksDir, 'alpha', false);

    const list = await listPlaybooks(playbooksDir);
    const slugs = list.map((p) => p.slug).sort();
    expect(slugs).toEqual(['alpha', 'beta']);
    const alpha = list.find((p) => p.slug === 'alpha')!;
    expect(alpha.enabled).toBe(false);
    const beta = list.find((p) => p.slug === 'beta')!;
    expect(beta.enabled).toBe(true);
  });

  it('returns detail for a disabled playbook with enabled: false', async () => {
    await writePlaybook('alpha');
    await setPlaybookEnabled(playbooksDir, 'alpha', false);
    const detail = await getPlaybookDetail(playbooksDir, 'alpha');
    expect(detail).not.toBeNull();
    expect(detail!.enabled).toBe(false);
  });

  it('resolves canonical slug for filename/frontmatter mismatch', async () => {
    await writePlaybook('filename-stem', 'Mismatch', 'canonical-bar');
    const detail = await getPlaybookDetail(playbooksDir, 'canonical-bar');
    expect(detail?.slug).toBe('canonical-bar');
    expect(await getPlaybookDetail(playbooksDir, 'filename-stem')).toBeNull();
  });
});

describe('dashboard playbook routes', () => {
  async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const app = express();
    app.use(express.json());
    app.use('/api/playbooks', createPlaybooksRouter(playbooksDir));
    const server = app.listen(0);
    await new Promise<void>((res) => server.once('listening', () => res()));
    const port = (server.address() as AddressInfo).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => new Promise((res) => server.close(() => res())),
    };
  }

  it('POST /:slug/disable then /:slug/enable round-trips through manifest and config', async () => {
    await writePlaybook('alpha');
    const { baseUrl, close } = await startServer();
    try {
      const disableRes = await fetch(`${baseUrl}/api/playbooks/alpha/disable`, { method: 'POST' });
      expect(disableRes.status).toBe(200);
      const disableBody = await disableRes.json();
      expect(disableBody).toMatchObject({ slug: 'alpha', enabled: false, changed: true });

      const cfgAfterDisable = await readConfig();
      expect(cfgAfterDisable.playbooks.disabled).toEqual(['alpha']);

      const manifest = await readFile(resolve(playbooksDir, 'manifest.md'), 'utf-8');
      expect(manifest).toContain('total: 0');

      const enableRes = await fetch(`${baseUrl}/api/playbooks/alpha/enable`, { method: 'POST' });
      const enableBody = await enableRes.json();
      expect(enableBody).toMatchObject({ slug: 'alpha', enabled: true, changed: true });

      const cfgAfterEnable = await readConfig();
      expect(cfgAfterEnable.playbooks.disabled).toEqual([]);
    } finally {
      await close();
    }
  });

  it('POST /:slug/enable returns 404 for unknown slug', async () => {
    const { baseUrl, close } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/playbooks/unknown/enable`, { method: 'POST' });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('DELETE /:slug scrubs the slug from the disabled list', async () => {
    await writePlaybook('alpha');
    await setPlaybookEnabled(playbooksDir, 'alpha', false);
    const { baseUrl, close } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/playbooks/alpha`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const cfg = await readConfig();
      expect(cfg.playbooks.disabled).toEqual([]);
    } finally {
      await close();
    }
  });

  it('routes use canonical slug for filename/frontmatter mismatch', async () => {
    await writePlaybook('filename-stem', 'Mismatch', 'canonical-bar');
    const { baseUrl, close } = await startServer();
    try {
      const detail = await fetch(`${baseUrl}/api/playbooks/canonical-bar`);
      expect(detail.status).toBe(200);
      const detailBody = await detail.json();
      expect(detailBody.slug).toBe('canonical-bar');

      const stale = await fetch(`${baseUrl}/api/playbooks/filename-stem`);
      expect(stale.status).toBe(404);

      const disable = await fetch(`${baseUrl}/api/playbooks/canonical-bar/disable`, {
        method: 'POST',
      });
      expect(disable.status).toBe(200);

      const editDisabled = await fetch(`${baseUrl}/api/playbooks/canonical-bar/edit`);
      expect(editDisabled.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe('rebuildPlaybookManifest direct', () => {
  it('treats absent disabled list as no-op', async () => {
    await writePlaybook('alpha');
    await rebuildPlaybookManifest(playbooksDir);
    const manifest = await readFile(resolve(playbooksDir, 'manifest.md'), 'utf-8');
    expect(manifest).toContain('total: 1');
    expect(manifest).toContain('alpha.md');
  });
});
