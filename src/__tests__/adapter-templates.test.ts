import { describe, it, expect } from 'vitest';
import {
  renderCursorProtocol,
  renderCursorTicket,
  renderCodexAgents,
  renderOpenCodeConfig,
  renderHermesSoul,
} from '../templates/index.js';

const TEST_PARAMS = {
  projectSlug: 'test-project',
  ticketSlug: 'test-ticket',
  projectDir: '/home/user/.syntaur/projects/test-project',
  ticketDir:
    '/home/user/.syntaur/projects/test-project/tickets/test-ticket',
};

describe('renderCursorProtocol', () => {
  it('starts with .mdc YAML frontmatter', () => {
    const out = renderCursorProtocol();
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('alwaysApply: true');
  });

  it('contains protocol directory structure', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('~/.syntaur/');
    expect(out).toContain('manifest.md');
    expect(out).toContain('ticket.md');
  });

  it('contains write boundary rules', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('Write Boundary Rules');
    expect(out).toContain('Files you may WRITE');
    expect(out).toContain('Files you must NEVER write');
  });

  it('contains lifecycle stages', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('backlog');
    expect(out).toContain('planning');
    expect(out).toContain('ready');
    expect(out).toContain('in_progress');
    expect(out).toContain('review');
    expect(out).toContain('done');
    expect(out).toContain('dropped');
  });

  it('contains lifecycle CLI commands', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('syntaur assign');
    expect(out).toContain('syntaur plan');
    expect(out).toContain('syntaur approve');
    expect(out).toContain('syntaur start');
    expect(out).toContain('syntaur review');
    expect(out).toContain('syntaur done');
    expect(out).toContain('syntaur drop');
    expect(out).toContain('syntaur block');
    expect(out).toContain('syntaur unblock');
    expect(out).toContain('syntaur park');
    expect(out).toContain('syntaur log');
    expect(out).toContain('syntaur new');
  });

  it('directs agents to syntaur show instead of hard-coded sidecar lists', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('syntaur show');
    expect(out).toContain('writer `agent`');
    expect(out).not.toContain('progress.md');
    expect(out).not.toContain('decision-record.md');
  });

  it('documents scratch project and id-prefixed folders', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('projects/scratch/');
    expect(out).toContain('<ID>-<slug>');
    expect(out).toContain('no standalone');
  });
});

describe('renderCursorTicket', () => {
  it('starts with .mdc YAML frontmatter', () => {
    const out = renderCursorTicket(TEST_PARAMS);
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('alwaysApply: true');
  });

  it('contains project and ticket context', () => {
    const out = renderCursorTicket(TEST_PARAMS);
    expect(out).toContain('test-project');
    expect(out).toContain('test-ticket');
    expect(out).toContain(TEST_PARAMS.projectDir);
    expect(out).toContain(TEST_PARAMS.ticketDir);
  });

  it('directs agents to syntaur show for file guidance', () => {
    const out = renderCursorTicket(TEST_PARAMS);
    expect(out).toContain('syntaur show');
    expect(out).toContain('Stage');
    expect(out).toContain('Commands');
    expect(out).toContain('writer `agent`');
  });
});

describe('renderCodexAgents', () => {
  it('does NOT have YAML frontmatter', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).not.toMatch(/^---\n/);
  });

  it('starts with heading', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toMatch(/^# Syntaur Protocol/);
  });

  it('contains ticket context', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('test-project');
    expect(out).toContain('test-ticket');
    expect(out).toContain(TEST_PARAMS.projectDir);
    expect(out).toContain(TEST_PARAMS.ticketDir);
  });

  it('contains preferred plugin workflows', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('syntaur-operator');
    expect(out).toContain('syntaur-protocol');
    expect(out).toContain('grab-ticket');
    expect(out).toContain('plan-ticket');
    expect(out).toContain('complete-ticket');
    expect(out).toContain('track-session');
  });

  it('contains protocol directory structure', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('~/.syntaur/');
    expect(out).toContain('manifest.md');
  });

  it('contains write boundary rules', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('Write Boundary Rules');
    expect(out).toContain('Files you may WRITE');
    expect(out).toContain('Files you must NEVER write');
  });

  it('contains context file guidance', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('.syntaur/context.json');
    expect(out).toContain('workspace boundary');
  });

  it('contains lifecycle stages and commands', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('backlog');
    expect(out).toContain('in_progress');
    expect(out).toContain('done');
    expect(out).toContain('syntaur assign');
    expect(out).toContain('syntaur start');
    expect(out).toContain('syntaur done');
    expect(out).toContain('syntaur log');
  });

  it('includes ticket-specific CLI commands', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain(
      `syntaur start ${TEST_PARAMS.ticketSlug} --project ${TEST_PARAMS.projectSlug}`,
    );
    expect(out).toContain(
      `syntaur log ${TEST_PARAMS.ticketSlug}`,
    );
  });

  it('directs agents to syntaur show for file guidance', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('syntaur show');
    expect(out).toContain('Stage');
    expect(out).toContain('Commands');
  });

  it('documents scratch project and id-prefixed folders', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('projects/scratch/');
    expect(out).toContain('<ID>-<slug>');
    expect(out).toContain('no standalone');
  });

  it('mentions template in conventions', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('`template`');
  });
});

describe('renderOpenCodeConfig', () => {
  it('produces valid JSON', () => {
    const out = renderOpenCodeConfig({
      projectDir: TEST_PARAMS.projectDir,
    });
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('has instructions array', () => {
    const out = renderOpenCodeConfig({
      projectDir: TEST_PARAMS.projectDir,
    });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.instructions)).toBe(true);
    expect(parsed.instructions.length).toBeGreaterThan(0);
  });

  it('references project.md path', () => {
    const out = renderOpenCodeConfig({
      projectDir: TEST_PARAMS.projectDir,
    });
    expect(out).toContain('project.md');
    expect(out).toContain(TEST_PARAMS.projectDir);
  });

  it('references syntaur show and log CLI', () => {
    const out = renderOpenCodeConfig({
      projectDir: TEST_PARAMS.projectDir,
    });
    expect(out).toContain('syntaur show');
    expect(out).toContain('syntaur log');
  });

  it('ends with newline', () => {
    const out = renderOpenCodeConfig({
      projectDir: TEST_PARAMS.projectDir,
    });
    expect(out).toMatch(/\n$/);
  });
});

describe('renderHermesSoul', () => {
  it('starts with a SOUL heading', () => {
    const out = renderHermesSoul(TEST_PARAMS);
    expect(out).toMatch(/^# SOUL/);
  });

  it('embeds the Syntaur protocol body', () => {
    const out = renderHermesSoul(TEST_PARAMS);
    expect(out).toContain('Syntaur Protocol');
    expect(out).toContain('Write Boundary Rules');
  });

  it('contains ticket context', () => {
    const out = renderHermesSoul(TEST_PARAMS);
    expect(out).toContain('test-project');
    expect(out).toContain('test-ticket');
    expect(out).toContain(TEST_PARAMS.ticketDir);
  });

  it('contains lifecycle commands', () => {
    const out = renderHermesSoul(TEST_PARAMS);
    expect(out).toContain('syntaur start');
    expect(out).toContain('syntaur done');
  });
});
