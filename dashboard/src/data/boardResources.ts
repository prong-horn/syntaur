/**
 * Board-family resource descriptors (templates, editable docs).
 * Uses the shared {@link Resource} shape from resources.ts without editing the
 * central catalog — Task 6 may fold these into resources.ts if desired.
 */
import type { EditableDocumentResponse } from './types';
import { apiUrl, type Resource } from './resources';

export interface TemplateContentResponse {
  content: string;
}

export const boardResources = {
  ticketTemplate: (): Resource<TemplateContentResponse> => ({
    url: apiUrl(['templates', 'ticket']),
    tags: ['templates'],
    meta: { kind: 'templates' },
    retain: false,
  }),

  projectTemplate: (): Resource<TemplateContentResponse> => ({
    url: apiUrl(['templates', 'project']),
    tags: ['templates'],
    meta: { kind: 'templates' },
    retain: false,
  }),

  projectEditDocument: (slug: string): Resource<EditableDocumentResponse> => ({
    url: apiUrl(['projects', slug, 'edit']),
    tags: ['document', 'project'],
    meta: { kind: 'document', projectSlug: slug },
    retain: false,
  }),
} as const;
