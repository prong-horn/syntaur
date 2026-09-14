import { useState, useEffect } from 'react';

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

let cachedConfig: TemplatesConfigResponse | null = null;
let fetchPromise: Promise<TemplatesConfigResponse> | null = null;

function fetchTemplatesConfig(): Promise<TemplatesConfigResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch('/api/ticket-templates')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        templates: Array<{ id: string; description: string }>;
      }>;
    })
    .then((data) => {
      const mapped: TemplatesConfigResponse = {
        definitions: data.templates.map((t) => ({
          id: t.id,
          label: t.id,
          description: t.description,
        })),
        default: 'feature',
      };
      cachedConfig = mapped;
      fetchPromise = null;
      return mapped;
    })
    .catch(() => {
      fetchPromise = null;
      return DEFAULT_TEMPLATES_CONFIG;
    });

  return fetchPromise;
}

export function useTemplates(): TemplatesConfigResponse {
  const [config, setConfig] = useState<TemplatesConfigResponse>(
    () => cachedConfig ?? DEFAULT_TEMPLATES_CONFIG,
  );

  useEffect(() => {
    fetchTemplatesConfig().then(setConfig);
  }, []);

  return config;
}

export function invalidateTemplatesCache(): void {
  cachedConfig = null;
  fetchPromise = null;
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
