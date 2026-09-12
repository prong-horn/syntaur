import { describe, expect, it } from 'vitest';
import { folderNameForTicketId } from '../utils/ticket-folder.js';

describe('folderNameForTicketId', () => {
  it('matches exact ticket id, not prefix siblings', () => {
    expect(folderNameForTicketId('SM-1-foo', 'SM-1')).toBe(true);
    expect(folderNameForTicketId('SM-10-bar', 'SM-1')).toBe(false);
    expect(folderNameForTicketId('SM-1-foo', 'SM-10')).toBe(false);
    expect(folderNameForTicketId('SM-10-bar', 'SM-10')).toBe(true);
  });
});
