import { escapeHtml } from '../utils/escape-html.js';
import type { ProofRenderParams } from './proof-md.js';
import type { ArtifactRow } from '../db/proof-db.js';

const INLINE_TEXT_LIMIT_BYTES = 256 * 1024; // 256 KB

const STYLE_BLOCK = `
  body { max-width: 920px; margin: 2rem auto; font-family: system-ui, -apple-system, sans-serif; padding: 0 1rem; color: #222; line-height: 1.5; }
  h1, h2, h3 { line-height: 1.25; }
  nav.toc { padding: 0.5rem 1rem; background: #f9f9f9; border-radius: 4px; margin-bottom: 2rem; }
  nav.toc ul { margin: 0; padding-left: 1.25rem; }
  section.criterion { padding: 1rem 0; border-bottom: 1px solid #eee; }
  section.criterion:last-of-type { border-bottom: none; }
  img, video { max-width: 100%; height: auto; border-radius: 4px; display: block; }
  pre { max-height: 480px; overflow: auto; padding: 1rem; background: #f5f5f5; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  .artifact { margin: 1rem 0; }
  .artifact-meta { font-size: 0.85em; color: #666; margin-bottom: 0.25rem; }
  .untagged { color: #666; font-size: 0.9em; }
  .stale { color: #b04a4a; font-style: italic; font-size: 0.9em; }
  .empty-criterion { color: #888; font-style: italic; }
  a { color: #2563eb; }
  .video-with-transcript { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 1rem; align-items: start; }
  .transcript { max-height: 480px; overflow: auto; font-size: 0.85em; line-height: 1.4; border: 1px solid #e5e5e5; border-radius: 4px; padding: 0.25rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .transcript .transcript-line { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 0.25rem 0.5rem; cursor: pointer; font: inherit; color: inherit; border-radius: 2px; }
  .transcript .transcript-line:hover { background: #f0f0f0; }
  .transcript .transcript-raw { padding: 0.25rem 0.5rem; color: #666; font-style: italic; }
  @media (max-width: 800px) { .video-with-transcript { grid-template-columns: 1fr; } }
`;

const TRANSCRIPT_CLICK_SCRIPT =
  `<script>document.addEventListener('click',function(e){var t=e.target.closest('[data-t]');if(!t)return;var w=t.closest('.video-with-transcript');if(!w)return;var v=w.querySelector('video');if(!v)return;v.currentTime=parseFloat(t.getAttribute('data-t'));v.play();});</script>`;

const PHRASE_LINE_RE = /^\s*\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]\s+(?:(S\d+)\s+)?(.+)$/;

function renderTranscriptPane(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = PHRASE_LINE_RE.exec(line);
    if (m) {
      const [, start, end, speaker, text] = m;
      const speakerSegment = speaker ? ` ${escapeHtml(speaker)}` : '';
      out.push(
        `<button type="button" class="transcript-line" data-t="${escapeHtml(start)}">[${escapeHtml(start)}-${escapeHtml(end)}]${speakerSegment} ${escapeHtml(text)}</button>`,
      );
    } else {
      out.push(`<div class="transcript-raw">${escapeHtml(line)}</div>`);
    }
  }
  return `<aside class="transcript">${out.join('')}</aside>`;
}

interface RenderArtifactCtx {
  inlineFiles: Map<string, string | null>; // file_path -> contents (null if too large or unread)
  transcriptSidecars: Map<string, string>; // artifact id -> transcript markdown
}

function renderArtifact(a: ArtifactRow, ctx: RenderArtifactCtx): string {
  const idEsc = escapeHtml(a.id);
  const noteHtml = a.note ? `<div class="artifact-meta">note: ${escapeHtml(a.note)}</div>` : '';
  const filePathEsc = a.file_path ? escapeHtml(a.file_path) : null;

  let body = '';
  switch (a.kind) {
    case 'screenshot':
      body = filePathEsc
        ? `<img src="${filePathEsc}" alt="screenshot artifact ${idEsc}">`
        : '<em>missing file</em>';
      break;
    case 'video': {
      if (!filePathEsc) {
        body = '<em>missing file</em>';
        break;
      }
      const transcriptMd = ctx.transcriptSidecars.get(a.id);
      const videoEl = `<video controls preload="metadata" src="${filePathEsc}"></video>`;
      body = transcriptMd
        ? `<div class="video-with-transcript">${videoEl}${renderTranscriptPane(transcriptMd)}</div>`
        : videoEl;
      break;
    }
    case 'asciinema':
      body = filePathEsc
        ? `<a href="${filePathEsc}" download>Open .cast file (${idEsc})</a> &mdash; <code>asciinema play &lt;file&gt;</code> to play locally`
        : '<em>missing file</em>';
      break;
    case 'http':
    case 'text': {
      const inline = a.file_path ? ctx.inlineFiles.get(a.file_path) : null;
      if (a.kind === 'http' && a.file_path && inline === null) {
        // file present but too large — fall back to download link
        body = `<a href="${filePathEsc}" download>Open transcript (${idEsc})</a>`;
      } else if (inline !== undefined && inline !== null) {
        body = `<pre><code>${escapeHtml(inline)}</code></pre>`;
      } else if (a.note) {
        body = `<pre><code>${escapeHtml(a.note)}</code></pre>`;
      } else {
        body = '<em>(empty)</em>';
      }
      break;
    }
    default:
      body = `<em>unknown kind: ${escapeHtml(a.kind)}</em>`;
  }

  return `<div class="artifact">${noteHtml}${body}<div class="artifact-meta"><code>${idEsc}</code></div></div>`;
}

export function renderProofHtml(
  params: ProofRenderParams,
  inlineFiles: Map<string, string | null> = new Map(),
  transcriptSidecars: Map<string, string> = new Map(),
): string {
  const { assignment, title, generated, criteria, artifactsByCriterion, untagged, staleByOriginalIndex } = params;
  const ctx: RenderArtifactCtx = { inlineFiles, transcriptSidecars };

  const totalArtifacts =
    untagged.length +
    staleByOriginalIndex.length +
    Array.from(artifactsByCriterion.values()).reduce((sum, list) => sum + list.length, 0);

  const titleEsc = escapeHtml(title);
  const assignmentEsc = escapeHtml(assignment);
  const generatedEsc = escapeHtml(generated);

  const tocItems = criteria
    .map((c) => `<li><a href="#criterion-${c.index}">${c.index}. ${escapeHtml(c.text)}</a></li>`)
    .join('\n      ');
  const otherTocItem =
    untagged.length > 0 || staleByOriginalIndex.length > 0
      ? '<li><a href="#other-artifacts">Other artifacts</a></li>'
      : '';

  const criteriaHtml = criteria
    .map((c) => {
      const tagged = artifactsByCriterion.get(c.index) ?? [];
      const heading = `<h2>${c.index}. <input type="checkbox" disabled${c.checked ? ' checked' : ''}> ${escapeHtml(c.text)}</h2>`;
      const body =
        tagged.length === 0
          ? '<p class="empty-criterion">no artifacts captured</p>'
          : tagged.map((a) => renderArtifact(a, ctx)).join('\n      ');
      return `<section id="criterion-${c.index}" class="criterion">\n      ${heading}\n      ${body}\n    </section>`;
    })
    .join('\n    ');

  const otherSection =
    untagged.length > 0 || staleByOriginalIndex.length > 0
      ? `<section id="other-artifacts" class="criterion">
      <h2>Other artifacts</h2>
      ${untagged.map((a) => `<div class="untagged">${renderArtifact(a, ctx)}</div>`).join('\n      ')}
      ${staleByOriginalIndex
        .map(
          (a) =>
            `<div class="stale">(was tagged criterion ${a.criterion_index ?? ''} — no longer present)\n      ${renderArtifact(a, ctx)}</div>`,
        )
        .join('\n      ')}
    </section>`
      : '';

  const emptyState =
    totalArtifacts === 0 && criteria.length === 0
      ? '<p>No artifacts captured for this assignment yet.</p>'
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proof — ${titleEsc}</title>
  <style>${STYLE_BLOCK}</style>
</head>
<body>
  <header>
    <h1>Proof — ${titleEsc}</h1>
    <p><small>Assignment: <code>${assignmentEsc}</code> · Generated: ${generatedEsc}</small></p>
  </header>
  ${
    criteria.length > 0 || untagged.length > 0 || staleByOriginalIndex.length > 0
      ? `<nav class="toc"><ul>
      ${tocItems}
      ${otherTocItem}
    </ul></nav>`
      : ''
  }
  <main>
    ${emptyState}
    ${criteriaHtml}
    ${otherSection}
  </main>
  ${transcriptSidecars.size > 0 ? TRANSCRIPT_CLICK_SCRIPT : ''}
</body>
</html>
`;
}

export { INLINE_TEXT_LIMIT_BYTES };
