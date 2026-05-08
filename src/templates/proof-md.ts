import type { ParsedAcceptanceCriterion } from '../utils/acceptance-criteria-parse.js';
import type { ArtifactRow } from '../db/proof-db.js';

export interface ProofRenderParams {
  assignment: string;
  title: string;
  generated: string;
  criteria: ParsedAcceptanceCriterion[];
  artifactsByCriterion: Map<number, ArtifactRow[]>;
  untagged: ArtifactRow[];
  staleByOriginalIndex: ArtifactRow[];
}

function renderArtifactBullet(a: ArtifactRow): string {
  const parts: string[] = [];
  parts.push(`**${a.kind}**`);
  parts.push(`\`${a.id}\``);
  if (a.file_path) parts.push(`file: \`${a.file_path}\``);
  if (a.note) parts.push(`note: ${a.note}`);
  return `- ${parts.join(' — ')}`;
}

export function renderProofMarkdown(params: ProofRenderParams): string {
  const { assignment, title, generated, criteria, artifactsByCriterion, untagged, staleByOriginalIndex } = params;

  const totalArtifacts =
    untagged.length +
    staleByOriginalIndex.length +
    Array.from(artifactsByCriterion.values()).reduce((sum, list) => sum + list.length, 0);

  const lines: string[] = [];
  lines.push('---');
  lines.push(`assignment: ${assignment}`);
  lines.push(`generated: "${generated}"`);
  lines.push('---');
  lines.push('');
  lines.push(`# Proof — ${title}`);
  lines.push('');

  if (totalArtifacts === 0) {
    lines.push('_No artifacts captured for this assignment yet._');
    lines.push('');
    return lines.join('\n');
  }

  for (const c of criteria) {
    const checkbox = c.checked ? '[x]' : '[ ]';
    lines.push(`## ${c.index}. ${checkbox} ${c.text}`);
    lines.push('');
    const tagged = artifactsByCriterion.get(c.index) ?? [];
    if (tagged.length === 0) {
      lines.push('_no artifacts captured_');
    } else {
      for (const a of tagged) lines.push(renderArtifactBullet(a));
    }
    lines.push('');
  }

  if (untagged.length > 0 || staleByOriginalIndex.length > 0) {
    lines.push('## Other artifacts');
    lines.push('');
    for (const a of untagged) lines.push(renderArtifactBullet(a));
    for (const a of staleByOriginalIndex) {
      const note = a.note ? ` — note: ${a.note}` : '';
      const file = a.file_path ? ` — file: \`${a.file_path}\`` : '';
      lines.push(
        `- _(was tagged criterion ${a.criterion_index} — no longer present)_ **${a.kind}** \`${a.id}\`${file}${note}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
