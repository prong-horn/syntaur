import { describe, it, expect } from 'vitest';
import {
  renderCursorProtocol,
  renderCursorAssignment,
  renderCodexAgents,
  renderOpenCodeConfig,
  renderHermesSoul,
} from '../templates/index.js';

const TEST_PARAMS = {
  projectSlug: 'test-project',
  ticketSlug: 'test-assignment',
  projectDir: '/home/user/.syntaur/projects/test-project',
  ticketDir:
    '/home/user/.syntaur/projects/test-project/tickets/test-assignment',
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

  it('contains lifecycle states', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('pending');
    expect(out).toContain('in_progress');
    expect(out).toContain('blocked');
    expect(out).toContain('review');
    expect(out).toContain('completed');
    expect(out).toContain('failed');
  });

  it('contains lifecycle CLI commands', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('syntaur assign');
    expect(out).toContain('syntaur start');
    expect(out).toContain('syntaur review');
    expect(out).toContain('syntaur complete');
    expect(out).toContain('syntaur block');
    expect(out).toContain('syntaur unblock');
    expect(out).toContain('syntaur fail');
    expect(out).toContain('syntaur comment');
    expect(out).toContain('syntaur new');
  });

  it('references v2.0 protocol files', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('progress.md');
    expect(out).toContain('comments.md');
  });

  it('documents standalone tickets', () => {
    const out = renderCursorProtocol();
    expect(out).toContain('standalone');
    expect(out).toMatch(/~\/\.syntaur\/assignments\//);
  });
});

describe('renderCursorAssignment', () => {
  it('starts with .mdc YAML frontmatter', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('alwaysApply: true');
  });

  it('contains project and ticket context', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toContain('test-project');
    expect(out).toContain('test-assignment');
    expect(out).toContain(TEST_PARAMS.projectDir);
    expect(out).toContain(TEST_PARAMS.ticketDir);
  });

  it('contains reading order', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toContain('project.md');
    expect(out).toContain('ticket.md');
    expect(out).toContain('plan*.md');
    expect(out).toContain('progress.md');
    expect(out).toContain('comments.md');
    expect(out).toContain('handoff.md');
  });

  it('lists writable files', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toContain('scratchpad.md');
    expect(out).toContain('decision-record.md');
    expect(out).toContain('progress.md');
  });

  it('flags comments.md as CLI-mediated', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toContain('syntaur comment');
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
    expect(out).toContain('test-assignment');
    expect(out).toContain(TEST_PARAMS.projectDir);
    expect(out).toContain(TEST_PARAMS.ticketDir);
  });

  it('contains preferred plugin workflows', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('syntaur-operator');
    expect(out).toContain('syntaur-protocol');
    expect(out).toContain('grab-ticket');
    expect(out).toContain('plan-assignment');
    expect(out).toContain('complete-assignment');
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

  it('contains lifecycle states and commands', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('pending');
    expect(out).toContain('in_progress');
    expect(out).toContain('completed');
    expect(out).toContain('syntaur assign');
    expect(out).toContain('syntaur start');
    expect(out).toContain('syntaur complete');
    expect(out).toContain('syntaur comment');
  });

  it('includes assignment-specific CLI commands', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain(
      `syntaur start ${TEST_PARAMS.ticketSlug} --project ${TEST_PARAMS.projectSlug}`,
    );
    expect(out).toContain(
      `syntaur comment ${TEST_PARAMS.ticketSlug}`,
    );
  });

  it('includes the manifest in reading order', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain(`${TEST_PARAMS.projectDir}/manifest.md`);
  });

  it('references v2.0 protocol files', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('progress.md');
    expect(out).toContain('comments.md');
  });

  it('documents --one-off for standalone tickets', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('--one-off');
    expect(out).toMatch(/~\/\.syntaur\/assignments\//);
  });

  it('mentions --type flag for new', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('--type');
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

  it('references v2.0 protocol files and CLIs', () => {
    const out = renderOpenCodeConfig({
      projectDir: TEST_PARAMS.projectDir,
    });
    expect(out).toContain('progress.md');
    expect(out).toContain('comments.md');
    expect(out).toContain('syntaur comment');
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
    expect(out).toContain('test-assignment');
    expect(out).toContain(TEST_PARAMS.ticketDir);
  });

  it('contains lifecycle commands', () => {
    const out = renderHermesSoul(TEST_PARAMS);
    expect(out).toContain('syntaur start');
    expect(out).toContain('syntaur complete');
  });
});
