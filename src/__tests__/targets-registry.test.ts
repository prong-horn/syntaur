import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  AGENT_TARGETS,
  getAgentTarget,
  agentTargetIds,
  adapterTargets,
  hermesSkillsDir,
  hermesHome,
  isHermesHomeCustom,
} from '../targets/registry.js';
import { RENDERERS } from '../targets/renderers.js';
import type { RendererKey } from '../targets/types.js';

const PARAMS = {
  projectSlug: 'p',
  assignmentSlug: 'a',
  projectDir: '/tmp/p',
  assignmentDir: '/tmp/p/assignments/a',
};

describe('target registry', () => {
  it('registers the expected agent ids', () => {
    expect(agentTargetIds().sort()).toEqual(
      ['claude', 'codex', 'cursor', 'hermes', 'opencode', 'openclaw', 'pi'].sort(),
    );
  });

  it('maps Syntaur ids to the correct skills.sh agent ids', () => {
    expect(getAgentTarget('hermes')?.skillsShAgentId).toBe('hermes-agent');
    expect(getAgentTarget('claude')?.skillsShAgentId).toBe('claude-code');
    expect(getAgentTarget('pi')?.skillsShAgentId).toBe('pi');
    expect(getAgentTarget('openclaw')?.skillsShAgentId).toBe('openclaw');
  });

  it('models codex as BOTH an adapter and a native plugin', () => {
    const codex = getAgentTarget('codex');
    expect(codex?.nativePlugin).toBe('codex');
    expect(codex?.instructions?.files.some((f) => f.path === 'AGENTS.md')).toBe(true);
  });

  it('models claude as native-plugin only (no adapter)', () => {
    const claude = getAgentTarget('claude');
    expect(claude?.nativePlugin).toBe('claude');
    expect(claude?.instructions).toBeUndefined();
  });

  it('adapterTargets excludes claude and includes the new agents', () => {
    const ids = adapterTargets().map((t) => t.id);
    expect(ids).not.toContain('claude');
    expect(ids).toEqual(expect.arrayContaining(['cursor', 'codex', 'opencode', 'pi', 'openclaw', 'hermes']));
  });

  it('every instruction renderer key resolves to a real function', () => {
    for (const t of AGENT_TARGETS) {
      for (const f of t.instructions?.files ?? []) {
        const fn = RENDERERS[f.renderer as RendererKey];
        expect(fn, `${t.id}:${f.renderer}`).toBeTypeOf('function');
        expect(typeof fn(PARAMS)).toBe('string');
      }
    }
  });

  it('resolves the expected global skills dirs', () => {
    expect(getAgentTarget('pi')?.skillsDir?.global).toBe(
      resolve(homedir(), '.pi', 'agent', 'skills'),
    );
    expect(getAgentTarget('openclaw')?.skillsDir?.global).toBe(
      resolve(homedir(), '.openclaw', 'skills'),
    );
  });

  it('hermes skills dir honors $HERMES_HOME', () => {
    const prev = process.env.HERMES_HOME;
    try {
      delete process.env.HERMES_HOME;
      expect(hermesHome()).toBe(resolve(homedir(), '.hermes'));
      expect(hermesSkillsDir()).toBe(resolve(homedir(), '.hermes', 'skills'));
      expect(isHermesHomeCustom()).toBe(false);

      process.env.HERMES_HOME = '/custom/hermes';
      expect(hermesHome()).toBe(resolve('/custom/hermes'));
      expect(hermesSkillsDir()).toBe(resolve('/custom/hermes', 'skills'));
      expect(isHermesHomeCustom()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = prev;
    }
  });

  afterEach(() => {
    // no-op: each test restores its own env
  });
});
