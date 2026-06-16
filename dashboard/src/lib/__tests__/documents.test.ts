import { describe, it, expect } from 'vitest';
import {
  parseAssignmentEditorState,
  updateAssignmentContent,
} from '../documents';

/**
 * These tests drive the public assignment editor entry points so the YAML
 * scalar codec (decodeScalar/encodeScalar via getScalar/setScalar/
 * formatYamlValue) and the inline-flow list parser (getStringList) are exercised
 * through a real parse -> serialize -> parse round-trip.
 */

const FM_PREFIX = '---\n';
const FM_SUFFIX = '\n---\n\nBody text.\n';

function assignmentDoc(frontmatter: string): string {
  return `${FM_PREFIX}${frontmatter}${FM_SUFFIX}`;
}

describe('documents YAML scalar codec + inline-flow lists', () => {
  it('(a) inline `tags: [a, b]` survives parse -> serialize -> parse (B1)', () => {
    const content = assignmentDoc(
      'title: Demo\nstatus: in_progress\ntags: [alpha, beta]',
    );

    const parsed = parseAssignmentEditorState(content);
    expect(parsed.tags).toBe('alpha, beta');

    // Re-serialize (touch only the body so tags are preserved) and re-parse.
    const serialized = updateAssignmentContent(content, { body: 'Changed.' });
    const reparsed = parseAssignmentEditorState(serialized);
    expect(reparsed.tags).toBe('alpha, beta');
  });

  it('(b) literal `"quoted"` scalar round-trips (B6)', () => {
    // The logical title value is literally: "quoted" (with the quote chars).
    const serialized = updateAssignmentContent(assignmentDoc('title: x'), {
      title: '"quoted"',
    });

    // On disk it must be escaped so it can decode back to the same literal.
    expect(serialized).toContain('title: "\\"quoted\\""');

    const reparsed = parseAssignmentEditorState(serialized);
    expect(reparsed.title).toBe('"quoted"');
  });

  it('(c) a value quoted only because it contains `:` decodes to bare content (no regression)', () => {
    const serialized = updateAssignmentContent(assignmentDoc('title: x'), {
      title: 'foo: bar',
    });

    // Quoted because of the colon, but no embedded quotes to escape.
    expect(serialized).toContain('title: "foo: bar"');

    const reparsed = parseAssignmentEditorState(serialized);
    expect(reparsed.title).toBe('foo: bar');
  });

  it('(d) an ISO timestamp value still decodes bare', () => {
    const iso = '2026-06-16T12:00:00Z';
    const content = assignmentDoc(`title: Demo\nstatus: x\nblockedReason: ${`"${iso}"`}`);

    const parsed = parseAssignmentEditorState(content);
    expect(parsed.blockedReason).toBe(iso);

    // And a freshly written timestamp scalar round-trips bare too.
    const serialized = updateAssignmentContent(content, { blockedReason: iso });
    expect(serialized).toContain(`blockedReason: "${iso}"`);
    expect(parseAssignmentEditorState(serialized).blockedReason).toBe(iso);
  });

  it('(e) empty `[]` stays empty', () => {
    const content = assignmentDoc('title: Demo\nstatus: x\ntags: []');

    expect(parseAssignmentEditorState(content).tags).toBe('');

    const serialized = updateAssignmentContent(content, { tags: '' });
    expect(serialized).toContain('tags: []');
    expect(parseAssignmentEditorState(serialized).tags).toBe('');
  });

  it('(f) a list element containing a comma and/or quote round-trips', () => {
    // dependsOn is a string list; commaListToArray splits the comma-joined input,
    // so we set it directly with a single element that itself contains specials.
    // Use the inline-flow parse path for the comma case (commas inside quotes
    // must not split the element).
    const inline = assignmentDoc(
      'title: Demo\nstatus: x\ntags: ["a, b", "she said \\"hi\\""]',
    );

    const parsed = parseAssignmentEditorState(inline);
    expect(parsed.tags).toBe('a, b, she said "hi"');

    // Now write a single tag containing a quote and confirm it round-trips
    // through the multiline writer (setStringList encodes each element).
    const written = updateAssignmentContent(assignmentDoc('title: Demo\nstatus: x\ntags: []'), {
      // commaListToArray would split on the comma, so test the quote element
      // as a standalone list member here.
      tags: 'plain, with"quote',
    });
    const writtenParsed = parseAssignmentEditorState(written);
    expect(writtenParsed.tags).toBe('plain, with"quote');
  });
});
