/**
 * Parse harness `configOptions` and `modes` from an ACP session open response.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { HarnessModes, HarnessOption, HarnessOptionChoice } from './types.js';

export function parseHarnessOptions(
  response: Pick<acp.NewSessionResponse, 'modes' | 'configOptions'>,
): { options: HarnessOption[]; modes: HarnessModes } {
  const options: HarnessOption[] = [];
  for (const raw of response.configOptions ?? []) {
    const option = raw as {
      id?: string;
      name?: string;
      description?: string | null;
      category?: string | null;
      type?: string;
      currentValue?: unknown;
      options?: Array<{ value?: string; name?: string; description?: string | null }>;
    };
    if (option.type !== 'select' || !option.id) continue;
    const choices: HarnessOptionChoice[] = [];
    for (const choice of option.options ?? []) {
      if (typeof choice.value !== 'string') continue;
      choices.push({
        value: choice.value,
        name: choice.name ?? choice.value,
        description: choice.description ?? null,
      });
    }
    options.push({
      id: option.id,
      name: option.name ?? option.id,
      category: option.category ?? null,
      currentValue: typeof option.currentValue === 'string' ? option.currentValue : null,
      choices,
    });
  }

  const modesRaw = response.modes as
    | {
        currentModeId?: string;
        availableModes?: Array<{ id?: string; name?: string; description?: string | null }>;
      }
    | undefined
    | null;

  let modes: HarnessModes = null;
  if (modesRaw?.currentModeId) {
    modes = {
      currentModeId: modesRaw.currentModeId,
      available: (modesRaw.availableModes ?? [])
        .filter((m): m is { id: string; name?: string; description?: string | null } => typeof m.id === 'string')
        .map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          description: m.description ?? null,
        })),
    };
  }

  return { options, modes };
}
