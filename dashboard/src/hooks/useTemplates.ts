import { useMemo } from 'react';
import { getDefaultResourceStore } from '../data/cache';
import { resources, type TicketTemplateSummaryResponse } from '../data/resources';
import { useResource } from '../data/useResource';

export interface TemplateDefinition {
  id: string;
  label?: string;
  description?: string;
}

export interface TemplatesConfigResponse {
  definitions: TemplateDefinition[];
  default: string;
}

const DEFAULT_TEMPLATES_CONFIG: TemplatesConfigResponse = {
  definitions: [
    { id: 'feature', label: 'feature', description: 'Full development cycle' },
    { id: 'bug', label: 'bug', description: 'Bug fix flow' },
    { id: 'quick', label: 'quick', description: 'Small chores' },
  ],
  default: 'feature',
};

function toConfig(data: TicketTemplateSummaryResponse | undefined): TemplatesConfigResponse {
  if (!data || !Array.isArray(data.templates)) return DEFAULT_TEMPLATES_CONFIG;
  return {
    definitions: data.templates.map((t) => ({ id: t.id, label: t.id, description: t.description })),
    default: 'feature',
  };
}

/** Ticket templates (read-only) from the shared store; defaults until loaded or on failure. */
export function useTemplates(): TemplatesConfigResponse {
  const { data } = useResource(resources.templates());
  return useMemo(() => toConfig(data), [data]);
}

export function invalidateTemplatesCache(): void {
  getDefaultResourceStore().invalidate([{ tag: 'templates' }]);
}

export function getTemplateLabel(config: TemplatesConfigResponse, templateId: string | null): string {
  if (!templateId) return '—';
  const found = config.definitions.find((d) => d.id === templateId);
  return found?.label ?? templateId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getTemplateDefinition(
  config: TemplatesConfigResponse,
  templateId: string | null,
): TemplateDefinition | null {
  if (!templateId) return null;
  return config.definitions.find((d) => d.id === templateId) ?? null;
}
