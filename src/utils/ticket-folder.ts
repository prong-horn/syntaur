import { isTicketId } from './ticket-ids.js';

export function formatTicketFolderName(id: string, slug: string): string {
  return `${id}-${slug}`;
}

export function parseTicketFolderName(
  folderName: string,
): { id: string; slug: string } | null {
  const match = folderName.match(/^([A-Z]{2,5}-\d+)-(.+)$/);
  if (!match || !isTicketId(match[1])) return null;
  return { id: match[1], slug: match[2] };
}

export function folderNameForTicketId(folderName: string, id: string): boolean {
  return parseTicketFolderName(folderName)?.id === id;
}
