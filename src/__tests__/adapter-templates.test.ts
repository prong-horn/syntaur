import { describe, it, expect } from 'vitest';
import {
  renderCursorProtocol,
  renderCursorAssignment,
  renderCodexAgents,
  renderOpenCodeConfig,
} from '../templates/index.js';

const TEST_PARAMS = {
  projectSlug: 'test-project',
  assignmentSlug: 'test-assignment',
  projectDir: '/home/user/.syntaur/projects/test-project',
  assignmentDir:
    '/home/user/.syntaur/projects/test-project/assignments/test-assignment',
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
    expect(out).toContain('assignment.md');
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
  });
});

describe('renderCursorAssignment', () => {
  it('starts with .mdc YAML frontmatter', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('alwaysApply: true');
  });

  it('contains project and assignment context', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toContain('test-project');
    expect(out).toContain('test-assignment');
    expect(out).toContain(TEST_PARAMS.projectDir);
    expect(out).toContain(TEST_PARAMS.assignmentDir);
  });

  it('contains reading order', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toContain('agent.md');
    expect(out).toContain('project.md');
    expect(out).toContain('assignment.md');
    expect(out).toContain('plan*.md');
    expect(out).toContain('handoff.md');
  });

  it('lists writable files', () => {
    const out = renderCursorAssignment(TEST_PARAMS);
    expect(out).toContain('scratchpad.md');
    expect(out).toContain('decision-record.md');
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

  it('contains assignment context', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('test-project');
    expect(out).toContain('test-assignment');
    expect(out).toContain(TEST_PARAMS.projectDir);
    expect(out).toContain(TEST_PARAMS.assignmentDir);
  });

  it('contains preferred plugin workflows', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain('syntaur-operator');
    expect(out).toContain('syntaur-protocol');
    expect(out).toContain('grab-assignment');
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
  });

  it('includes assignment-specific CLI commands', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain(
      `syntaur start ${TEST_PARAMS.assignmentSlug} --project ${TEST_PARAMS.projectSlug}`,
    );
  });

  it('includes the manifest in reading order', () => {
    const out = renderCodexAgents(TEST_PARAMS);
    expect(out).toContain(`${TEST_PARAMS.projectDir}/manifest.md`);
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

  it('references agent.md path', () => {
    const out = renderOpenCodeConfig({
      projectDir: TEST_PARAMS.projectDir,
    });
    expect(out).toContain('agent.md');
    expect(out).toContain(TEST_PARAMS.projectDir);
  });

  it('ends with newline', () => {
    const out = renderOpenCodeConfig({
      projectDir: TEST_PARAMS.projectDir,
    });
    expect(out).toMatch(/\n$/);
  });
});
