import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useLiveActivity } from '../useLiveActivity.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

const WAIT_TIMEOUT = 20000;

function session(overrides: Partial<AgentSessionWithLiveness>): AgentSessionWithLiveness {
  return {
    sessionId: 's1', agent: 'claude', started: '2026-07-01T00:00:00Z', status: 'active',
    isLive: true, resumeSupported: true, forkSupported: false,
    projectSlug: null, assignmentSlug: null, path: '/tmp/s1',
    ...overrides,
  } as AgentSessionWithLiveness;
}

function Probe({ sessions }: { sessions: AgentSessionWithLiveness[] }) {
  const activity = useLiveActivity(sessions);
  return <Text>{JSON.stringify([...activity.entries()])}</Text>;
}

describe('useLiveActivity', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'syntaur-live-activity-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('extracts an activity phrase from a live session transcript', async () => {
    const transcriptPath = resolve(dir, 's1.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }) + '\n',
    );
    const { lastFrame, unmount } = render(<Probe sessions={[session({ transcriptPath })]} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Bash: npm test'), { timeout: WAIT_TIMEOUT });
    unmount();
  });

  it('ignores dead sessions and sessions with no transcriptPath', async () => {
    const { lastFrame, unmount } = render(
      <Probe sessions={[session({ isLive: false, sessionId: 'dead' }), session({ transcriptPath: null, sessionId: 'no-path' })]} />,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame() ?? '').toBe('[]');
    unmount();
  });

  it('drops a session from the map once it is no longer live', async () => {
    const transcriptPath = resolve(dir, 's1.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }) + '\n',
    );
    const { lastFrame, rerender, unmount } = render(<Probe sessions={[session({ transcriptPath })]} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Bash: npm test'), { timeout: WAIT_TIMEOUT });

    rerender(<Probe sessions={[session({ transcriptPath, isLive: false })]} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toBe('[]'), { timeout: WAIT_TIMEOUT });
    unmount();
  });

  it('restarts the watcher when the same session gets a new transcriptPath', async () => {
    // Regression: watchers were keyed only by sessionId, so a later
    // transcriptPath change for the SAME session kept tailing the old file
    // forever instead of switching to the new one.
    const pathA = resolve(dir, 'a.jsonl');
    const pathB = resolve(dir, 'b.jsonl');
    await writeFile(pathA, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'first command' } }] } }) + '\n');
    await writeFile(pathB, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'second command' } }] } }) + '\n');

    const { lastFrame, rerender, unmount } = render(<Probe sessions={[session({ transcriptPath: pathA })]} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('first command'), { timeout: WAIT_TIMEOUT });

    rerender(<Probe sessions={[session({ transcriptPath: pathB })]} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('second command'), { timeout: WAIT_TIMEOUT });
    unmount();
  });
});
