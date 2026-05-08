/**
 * Replace HTML-special characters with their entity equivalents so the
 * input can be safely embedded inside an HTML document. Used by the proof
 * page renderer for criterion text, artifact notes, and inline `text`/`http`
 * payloads.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
