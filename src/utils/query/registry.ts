/**
 * Query field registry for v2 — ticket frontmatter fields only (no custom facts).
 */

import { TICKET_FIELDS, type FieldRegistry } from './fields.js';

/** Build the query registry (TICKET_FIELDS only; no custom fact declarations). */
export function buildQueryRegistry(): FieldRegistry {
  return { ...TICKET_FIELDS };
}

/**
 * CamelCase field names advertised for AQL autocomplete (v2 vocabulary).
 * Status values are stage ids; deprecated v1 dimensions and custom facts are omitted.
 */
export function queryFieldNames(): string[] {
  return [
    'status',
    'priority',
    'template',
    'assignee',
    'project',
    'tag',
    'tags',
    'title',
    'search',
    'created',
    'updated',
    'completedAt',
    'statusAge',
    'blocked',
    'parked',
  ];
}
