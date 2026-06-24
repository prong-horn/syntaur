import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { captureCommand } from '../commands/capture.js';
import { proofBuildCommand } from '../commands/proof.js';
import { renderProofMarkdown } from '../templates/proof-md.js';
import { renderProofHtml } from '../templates/proof-html.js';
import {
  closeProofDb,
  resetProofDb,
  initProofDb,
  insertArtifact,
} from '../db/proof-db.js';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { openEngagement } from '../db/engagement-db.js';

let testDir: string;
let origSyntaurHome: string | undefined;
let origSessionEnv: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-proof-build-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
  origSessionEnv = process.env.CLAUDE_CODE_SESSION_ID;
  resetProofDb();
  resetSessionDb();
});

afterEach(async () => {
  closeProofDb();
  closeSessionDb();
  resetSessionDb();
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  if (origSessionEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = origSessionEnv;
  await rm(testDir, { recursive: true, force: true });
});

async function setupProjectAssignmentWithCriteria(criteriaLines: string[]): Promise<{ assignmentDir: string }> {
  await createProjectCommand('P', { dir: testDir });
  await createAssignmentCommand('A', { project: 'p', dir: testDir });
  const assignmentDir = resolve(testDir, 'p', 'assignments', 'a');
  const assignmentMd = resolve(assignmentDir, 'assignment.md');
  let content = await readFile(assignmentMd, 'utf-8');
  // Replace or append acceptance criteria section
  const criteriaSection = ['## Acceptance Criteria', '', ...criteriaLines, ''].join('\n');
  if (/^## Acceptance Criteria/m.test(content)) {
    content = content.replace(/## Acceptance Criteria[\s\S]*?(?=\n## |$)/, criteriaSection);
  } else {
    content = content + '\n' + criteriaSection;
  }
  await writeFile(assignmentMd, content);
  return { assignmentDir };
}

describe('renderProofMarkdown', () => {
  it('renders empty state when there are no artifacts and no criteria', () => {
    const md = renderProofMarkdown({
      assignment: 'p/a',
      title: 'Demo',
      generated: '2026-05-08T00:00:00Z',
      criteria: [],
      artifactsByCriterion: new Map(),
      untagged: [],
      staleByOriginalIndex: [],
    });
    expect(md).toMatch(/No artifacts captured for this assignment yet/);
  });

  it('renders criterion-anchored sections with tagged artifacts', () => {
    const md = renderProofMarkdown({
      assignment: 'p/a',
      title: 'Demo',
      generated: '2026-05-08T00:00:00Z',
      criteria: [
        { index: 0, text: 'First', checked: false },
        { index: 1, text: 'Second', checked: true },
      ],
      artifactsByCriterion: new Map([
        [
          0,
          [
            {
              id: 'art-1',
              assignment_id: 'asn',
              assignment_dir: '/d',
              criterion_index: 0,
              kind: 'text',
              file_path: null,
              note: 'verified first',
              created_at: '2026-05-08T00:00:00Z',
            },
          ],
        ],
      ]),
      untagged: [],
      staleByOriginalIndex: [],
    });
    expect(md).toMatch(/## 0\. \[ \] First/);
    expect(md).toMatch(/## 1\. \[x\] Second/);
    expect(md).toMatch(/verified first/);
    expect(md).toMatch(/no artifacts captured/); // criterion 1 is empty
  });

  it('renders Other artifacts section for untagged + stale', () => {
    const md = renderProofMarkdown({
      assignment: 'p/a',
      title: 'Demo',
      generated: '2026-05-08T00:00:00Z',
      criteria: [{ index: 0, text: 'Only', checked: false }],
      artifactsByCriterion: new Map(),
      untagged: [
        {
          id: 'u1',
          assignment_id: 'asn',
          assignment_dir: '/d',
          criterion_index: null,
          kind: 'text',
          file_path: null,
          note: 'general',
          created_at: '2026-05-08T00:00:00Z',
        },
      ],
      staleByOriginalIndex: [
        {
          id: 's1',
          assignment_id: 'asn',
          assignment_dir: '/d',
          criterion_index: 99,
          kind: 'text',
          file_path: null,
          note: 'stale',
          created_at: '2026-05-08T00:00:00Z',
        },
      ],
    });
    expect(md).toMatch(/## Other artifacts/);
    expect(md).toMatch(/general/);
    expect(md).toMatch(/was tagged criterion 99/);
  });
});

describe('renderProofHtml', () => {
  it('escapes HTML-special chars in criterion text and notes', () => {
    const html = renderProofHtml({
      assignment: 'p/a',
      title: 'Demo <x>',
      generated: '2026-05-08T00:00:00Z',
      criteria: [{ index: 0, text: '<script>alert(1)</script>', checked: false }],
      artifactsByCriterion: new Map([
        [
          0,
          [
            {
              id: 'a',
              assignment_id: 'asn',
              assignment_dir: '/d',
              criterion_index: 0,
              kind: 'text',
              file_path: null,
              note: '"quoted" & <bad>',
              created_at: '2026-05-08T00:00:00Z',
            },
          ],
        ],
      ]),
      untagged: [],
      staleByOriginalIndex: [],
    });
    // No raw <script tags
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toMatch(/&lt;script&gt;/);
    // Note escaped
    expect(html).toMatch(/&quot;quoted&quot;/);
    // Title escaped
    expect(html).toMatch(/Proof — Demo &lt;x&gt;/);
  });

  it('renders <img> for screenshot, <video> for video, <a download> for asciinema', () => {
    const html = renderProofHtml({
      assignment: 'p/a',
      title: 'Demo',
      generated: '2026-05-08T00:00:00Z',
      criteria: [{ index: 0, text: 'C', checked: false }],
      artifactsByCriterion: new Map([
        [
          0,
          [
            {
              id: 'shot',
              assignment_id: 'asn',
              assignment_dir: '/d',
              criterion_index: 0,
              kind: 'screenshot',
              file_path: 'proof/0/shot.png',
              note: null,
              created_at: '',
            },
            {
              id: 'vid',
              assignment_id: 'asn',
              assignment_dir: '/d',
              criterion_index: 0,
              kind: 'video',
              file_path: 'proof/0/vid.mp4',
              note: null,
              created_at: '',
            },
            {
              id: 'cast',
              assignment_id: 'asn',
              assignment_dir: '/d',
              criterion_index: 0,
              kind: 'asciinema',
              file_path: 'proof/0/cast.cast',
              note: null,
              created_at: '',
            },
          ],
        ],
      ]),
      untagged: [],
      staleByOriginalIndex: [],
    });
    expect(html).toMatch(/<img src="proof\/0\/shot\.png"/);
    expect(html).toMatch(/<video controls preload="metadata" src="proof\/0\/vid\.mp4"/);
    expect(html).toMatch(/<a href="proof\/0\/cast\.cast" download/);
    // No iframe
    expect(html).not.toMatch(/<iframe/);
  });

  it('inlines text/http content from inlineFiles map; falls back to download link if too large', () => {
    const inlineFiles = new Map<string, string | null>([
      ['proof/untagged/short.txt', 'request body here'],
      ['proof/untagged/big.txt', null], // simulated too-large
    ]);
    const html = renderProofHtml(
      {
        assignment: 'p/a',
        title: 'Demo',
        generated: '',
        criteria: [],
        artifactsByCriterion: new Map(),
        untagged: [
          {
            id: 'small',
            assignment_id: 'asn',
            assignment_dir: '/d',
            criterion_index: null,
            kind: 'http',
            file_path: 'proof/untagged/short.txt',
            note: null,
            created_at: '',
          },
          {
            id: 'big',
            assignment_id: 'asn',
            assignment_dir: '/d',
            criterion_index: null,
            kind: 'http',
            file_path: 'proof/untagged/big.txt',
            note: null,
            created_at: '',
          },
        ],
        staleByOriginalIndex: [],
      },
      inlineFiles,
    );
    expect(html).toMatch(/<pre><code>request body here<\/code><\/pre>/);
    expect(html).toMatch(/<a href="proof\/untagged\/big\.txt" download/);
  });
});

describe('proofBuildCommand', () => {
  it('writes proof.md and proof.html with tagged + untagged artifacts', async () => {
    const { assignmentDir } = await setupProjectAssignmentWithCriteria(['- [ ] First crit', '- [x] Second crit']);

    await captureCommand('a', {
      kind: 'text',
      note: 'verified first',
      criterion: 0,
      project: 'p',
      dir: testDir,
    });
    await captureCommand('a', {
      kind: 'text',
      note: 'general purpose note',
      project: 'p',
      dir: testDir,
    });

    const result = await proofBuildCommand('a', { project: 'p', dir: testDir });
    expect(result.htmlPath).toBe(resolve(assignmentDir, 'proof.html'));
    expect(result.mdPath).toBe(resolve(assignmentDir, 'proof.md'));

    const md = await readFile(result.mdPath, 'utf-8');
    expect(md).toMatch(/## 0\. \[ \] First crit/);
    expect(md).toMatch(/verified first/);
    expect(md).toMatch(/## Other artifacts/);
    expect(md).toMatch(/general purpose note/);

    const html = await readFile(result.htmlPath, 'utf-8');
    expect(html).toMatch(/Proof — A/); // assignment title from create-assignment is "A"
    expect(html).toMatch(/criterion-0/);
  });

  it('routes out-of-range criterion to Other artifacts with a stale annotation', async () => {
    await setupProjectAssignmentWithCriteria(['- [ ] Only one crit']);

    await captureCommand('a', {
      kind: 'text',
      note: 'tagged-future',
      criterion: 99,
      project: 'p',
      dir: testDir,
    });

    const result = await proofBuildCommand('a', { project: 'p', dir: testDir });
    const md = await readFile(result.mdPath, 'utf-8');
    expect(md).toMatch(/## Other artifacts/);
    expect(md).toMatch(/was tagged criterion 99/);
  });

  it('renders empty pages for an assignment with no captures', async () => {
    await setupProjectAssignmentWithCriteria(['- [ ] First']);

    const result = await proofBuildCommand('a', { project: 'p', dir: testDir });
    const md = await readFile(result.mdPath, 'utf-8');
    expect(md).toMatch(/No artifacts captured/);
  });

  it('overwrites an existing proof.html cleanly (atomic re-run)', async () => {
    const { assignmentDir } = await setupProjectAssignmentWithCriteria(['- [ ] First']);

    // First build
    await captureCommand('a', { kind: 'text', note: 'one', project: 'p', dir: testDir });
    await proofBuildCommand('a', { project: 'p', dir: testDir });
    const first = await readFile(resolve(assignmentDir, 'proof.html'), 'utf-8');

    // Second capture + rebuild
    await captureCommand('a', { kind: 'text', note: 'two', project: 'p', dir: testDir });
    await proofBuildCommand('a', { project: 'p', dir: testDir });
    const second = await readFile(resolve(assignmentDir, 'proof.html'), 'utf-8');

    expect(second).not.toBe(first);
    expect(second).toMatch(/two/);
  });

  it('handles a missing ## Acceptance Criteria section gracefully', async () => {
    // Set up project + assignment, then strip the criteria section from assignment.md.
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('A', { project: 'p', dir: testDir });
    const assignmentDir = resolve(testDir, 'p', 'assignments', 'a');
    const assignmentMd = resolve(assignmentDir, 'assignment.md');
    const content = await readFile(assignmentMd, 'utf-8');
    const stripped = content.replace(/## Acceptance Criteria[\s\S]*?(?=\n## |$)/, '');
    await writeFile(assignmentMd, stripped);

    await captureCommand('a', { kind: 'text', note: 'untagged-note', project: 'p', dir: testDir });
    const result = await proofBuildCommand('a', { project: 'p', dir: testDir });
    const md = await readFile(result.mdPath, 'utf-8');
    expect(md).toMatch(/untagged-note/);
  });

  it('does not read files outside the assignment proof/ tree even if a row points elsewhere', async () => {
    const { assignmentDir } = await setupProjectAssignmentWithCriteria(['- [ ] One']);

    // Drop a sensitive file outside the assignment dir.
    const outsidePath = resolve(testDir, 'sensitive.txt');
    await writeFile(outsidePath, 'SENSITIVE: should not appear in proof.html');

    // Compute the assignment's frontmatter id, then directly inject a row
    // whose file_path traverses outside the proof/ tree.
    const asnMd = await readFile(resolve(assignmentDir, 'assignment.md'), 'utf-8');
    const idMatch = asnMd.match(/^id:\s*(.+)$/m);
    const id = idMatch ? idMatch[1].trim() : '';
    initProofDb();
    insertArtifact({
      id: 'malicious',
      assignmentId: id,
      assignmentDir,
      criterionIndex: null,
      kind: 'text',
      filePath: '../../../sensitive.txt',
      note: null,
    });

    const result = await proofBuildCommand('a', { project: 'p', dir: testDir });
    const html = await readFile(result.htmlPath, 'utf-8');

    expect(html).not.toMatch(/SENSITIVE/);
  });

  it('builds against a standalone (UUID) assignment via the session open engagement', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
    const standaloneDir = resolve(testDir, 'assignments', id);
    await mkdir(standaloneDir, { recursive: true });
    await writeFile(
      resolve(standaloneDir, 'assignment.md'),
      [
        '---',
        `id: ${id}`,
        'slug: example',
        'title: Standalone Demo',
        'status: pending',
        'priority: medium',
        'created: "2026-04-20T00:00:00Z"',
        'updated: "2026-04-20T00:00:00Z"',
        'project: null',
        '---',
        '',
        '# Standalone',
        '',
        '## Acceptance Criteria',
        '- [ ] Single crit',
        '',
      ].join('\n'),
    );

    // No positional + no --project: proofBuildCommand resolves the target from
    // the session's OPEN engagement (the demoted context.json scalar is gone).
    // Drive the seam by (a) injecting a deterministic session id so
    // resolveOwnSessionId resolves it from env (layer 2), and (b) seeding an
    // open engagement bound to this standalone assignment.
    const sessionId = 'sess-proof-standalone';
    process.env.CLAUDE_CODE_SESSION_ID = sessionId;
    initSessionDb(resolve(testDir, 'syntaur.db'));
    openEngagement({
      sessionId,
      assignmentId: id,
      projectSlug: null,
      assignmentSlug: id,
      stage: 'implement',
      startedAt: '2026-04-20T00:00:00Z',
    });

    // Inject a proof artifact directly (the capture path is rewired separately).
    initProofDb();
    insertArtifact({
      id: 'standalone-art',
      assignmentId: id,
      assignmentDir: standaloneDir,
      criterionIndex: null,
      kind: 'text',
      filePath: null,
      note: 'standalone-build',
    });

    const workingDir = resolve(testDir, 'work');
    await mkdir(workingDir, { recursive: true });

    const result = await proofBuildCommand(undefined, { cwd: workingDir, dir: testDir });
    const md = await readFile(result.mdPath, 'utf-8');
    expect(md).toMatch(/standalone-build/);
    const html = await readFile(result.htmlPath, 'utf-8');
    expect(html).toMatch(/Standalone Demo/);
  });
});

describe('renderProofHtml — transcript sidecars', () => {
  function videoArtifact(id: string, filePath: string) {
    return {
      id,
      assignment_id: 'asn',
      assignment_dir: '/d',
      criterion_index: 0,
      kind: 'video' as const,
      file_path: filePath,
      note: null,
      created_at: '',
    };
  }

  function paramsForVideo(id: string, filePath: string) {
    return {
      assignment: 'p/a',
      title: 'Demo',
      generated: '2026-05-08T00:00:00Z',
      criteria: [{ index: 0, text: 'C', checked: false }],
      artifactsByCriterion: new Map([[0, [videoArtifact(id, filePath)]]]),
      untagged: [],
      staleByOriginalIndex: [],
    };
  }

  it('renders bare <video> when no sidecar is present (AC5 regression)', () => {
    const html = renderProofHtml(paramsForVideo('vid1', 'proof/0/vid1.mp4'));
    expect(html).toMatch(/<video controls preload="metadata" src="proof\/0\/vid1\.mp4"><\/video>/);
    // The wrapper div should not appear in the body — STYLE_BLOCK still names
    // the class for the with-sidecar case, so search for the wrapper element.
    expect(html).not.toMatch(/<div class="video-with-transcript">/);
    expect(html).not.toMatch(/data-t=/);
    expect(html).not.toMatch(/<button[^>]*class="transcript-line"/);
  });

  it('renders two-column layout + clickable phrase buttons when sidecar exists', () => {
    const transcripts = new Map([
      ['vid1', '  [000.00-001.50] S0 hello world\n  [001.50-003.00] second phrase\n'],
    ]);
    const html = renderProofHtml(
      paramsForVideo('vid1', 'proof/0/vid1.mp4'),
      new Map(),
      transcripts,
    );
    expect(html).toMatch(/class="video-with-transcript"/);
    expect(html).toMatch(/<button type="button" class="transcript-line" data-t="000\.00">/);
    expect(html).toMatch(/<button type="button" class="transcript-line" data-t="001\.50">/);
    // Click handler script appears exactly once
    const matches = html.match(/document\.addEventListener\('click'/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('renders S<n> only when speaker tag is present in the line (matches python optional-speaker)', () => {
    const transcripts = new Map([
      ['vid1', '  [000.00-001.00] hello\n  [001.00-002.00] S0 world\n'],
    ]);
    const html = renderProofHtml(
      paramsForVideo('vid1', 'proof/0/vid1.mp4'),
      new Map(),
      transcripts,
    );
    // First button: no S<n> after the bracket pair
    expect(html).toMatch(/data-t="000\.00">\[000\.00-001\.00\] hello</);
    // Second button: S0 appears between bracket pair and text
    expect(html).toMatch(/data-t="001\.00">\[001\.00-002\.00\] S0 world</);
  });

  it('renders malformed lines as escaped transcript-raw divs, not buttons', () => {
    const transcripts = new Map([
      ['vid1', '  [000.00-001.00] valid line\nnot a phrase line <script>\n'],
    ]);
    const html = renderProofHtml(
      paramsForVideo('vid1', 'proof/0/vid1.mp4'),
      new Map(),
      transcripts,
    );
    expect(html).toMatch(/class="transcript-line" data-t="000\.00"/);
    expect(html).toMatch(/<div class="transcript-raw">not a phrase line &lt;script&gt;<\/div>/);
    // No raw <script> tag escapes through
    expect(html).not.toMatch(/<div class="transcript-raw">[^<]*<script>/);
  });

  it('omits the click-handler script entirely when no sidecars are passed', () => {
    const html = renderProofHtml(paramsForVideo('vid1', 'proof/0/vid1.mp4'));
    expect(html).not.toMatch(/document\.addEventListener\('click'/);
  });

  it('produces byte-identical output on repeated renders (AC7 idempotent rebuild)', () => {
    const transcripts = new Map([
      ['vid1', '  [000.00-001.50] S0 hello world\n'],
    ]);
    const params = paramsForVideo('vid1', 'proof/0/vid1.mp4');
    const a = renderProofHtml(params, new Map(), transcripts);
    const b = renderProofHtml(params, new Map(), transcripts);
    expect(a).toBe(b);
  });
});

describe('renderProofMarkdown — transcript sidecars', () => {
  it('appends `transcript: <id>.transcript.md` line under video artifact when sidecar present', () => {
    const md = renderProofMarkdown({
      assignment: 'p/a',
      title: 'Demo',
      generated: '2026-05-08T00:00:00Z',
      criteria: [{ index: 0, text: 'C', checked: false }],
      artifactsByCriterion: new Map([
        [
          0,
          [
            {
              id: 'vid1',
              assignment_id: 'asn',
              assignment_dir: '/d',
              criterion_index: 0,
              kind: 'video' as const,
              file_path: 'proof/0/vid1.mp4',
              note: null,
              created_at: '',
            },
          ],
        ],
      ]),
      untagged: [],
      staleByOriginalIndex: [],
      transcriptSidecars: new Map([['vid1', '  [000.00-001.00] hi\n']]),
    });
    expect(md).toMatch(/transcript: `vid1\.transcript\.md`/);
  });

  it('omits transcript line when no sidecar present', () => {
    const md = renderProofMarkdown({
      assignment: 'p/a',
      title: 'Demo',
      generated: '2026-05-08T00:00:00Z',
      criteria: [{ index: 0, text: 'C', checked: false }],
      artifactsByCriterion: new Map([
        [
          0,
          [
            {
              id: 'vid1',
              assignment_id: 'asn',
              assignment_dir: '/d',
              criterion_index: 0,
              kind: 'video' as const,
              file_path: 'proof/0/vid1.mp4',
              note: null,
              created_at: '',
            },
          ],
        ],
      ]),
      untagged: [],
      staleByOriginalIndex: [],
    });
    expect(md).not.toMatch(/transcript:/);
  });
});
