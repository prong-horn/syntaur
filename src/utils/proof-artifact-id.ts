import { randomBytes } from 'node:crypto';
import type { ArtifactKind } from '../db/proof-db.js';

/**
 * Generate a short, sortable artifact id: base36 timestamp + 4 random hex
 * chars (e.g. `lqy3a4t8-1f9e`). Collision space is ~65 K per millisecond,
 * which is comfortably safe for human-rate captures; the capture command
 * still does a uniqueness check before insert.
 */
export function generateArtifactId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `${ts}-${rand}`;
}

const EXTENSIONS: Record<ArtifactKind, string> = {
  screenshot: 'png',
  video: 'mp4',
  asciinema: 'cast',
  http: 'txt',
  text: 'txt',
};

export function extensionForKind(kind: ArtifactKind): string {
  const ext = EXTENSIONS[kind];
  if (!ext) {
    throw new Error(`Unknown artifact kind: ${kind}`);
  }
  return ext;
}

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'screenshot',
  'video',
  'asciinema',
  'http',
  'text',
] as const;

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value);
}
