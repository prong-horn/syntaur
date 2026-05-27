import { useState, useEffect } from 'react';

export interface TypeDefinition {
  id: string;
  label?: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface TypesConfigResponse {
  definitions: TypeDefinition[];
  default: string;
  custom: boolean;
}

const DEFAULT_TYPES_CONFIG: TypesConfigResponse = {
  definitions: [
    { id: 'feature', label: 'Feature' },
    { id: 'bug', label: 'Bug' },
    { id: 'refactor', label: 'Refactor' },
    { id: 'research', label: 'Research' },
    { id: 'chore', label: 'Chore' },
  ],
  default: 'feature',
  custom: false,
};

let cachedConfig: TypesConfigResponse | null = null;
let fetchPromise: Promise<TypesConfigResponse> | null = null;

function fetchTypesConfig(): Promise<TypesConfigResponse> {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch('/api/config/types')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<TypesConfigResponse>;
    })
    .then((data) => {
      cachedConfig = data;
      fetchPromise = null;
      return data;
    })
    .catch(() => {
      fetchPromise = null;
      return DEFAULT_TYPES_CONFIG;
    });

  return fetchPromise;
}

export function useTypesConfig(): TypesConfigResponse {
  const [config, setConfig] = useState<TypesConfigResponse>(
    () => cachedConfig ?? DEFAULT_TYPES_CONFIG,
  );

  useEffect(() => {
    fetchTypesConfig().then(setConfig);
  }, []);

  return config;
}

export function invalidateTypesConfigCache(): void {
  cachedConfig = null;
  fetchPromise = null;
}

export function getTypeLabel(config: TypesConfigResponse, typeId: string | null): string {
  if (!typeId) return '—';
  const found = config.definitions.find((d) => d.id === typeId);
  return found?.label ?? typeId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getTypeDefinition(
  config: TypesConfigResponse,
  typeId: string | null,
): TypeDefinition | null {
  if (!typeId) return null;
  return config.definitions.find((d) => d.id === typeId) ?? null;
}
