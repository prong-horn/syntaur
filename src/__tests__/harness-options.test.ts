import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHarnessOptions } from '../chat/harness-options.js';
import type * as acp from '@agentclientprotocol/sdk';

const cursorFixturePath = resolve(
  import.meta.dirname,
  'fixtures/acp/cursor/06-edits-permissions.ndjson',
);

function cursorSessionNewResponse(): Pick<acp.NewSessionResponse, 'modes' | 'configOptions'> {
  const line = readFileSync(cursorFixturePath, 'utf-8').trim().split('\n')[3]!;
  const msg = JSON.parse(line).msg as { result: Pick<acp.NewSessionResponse, 'modes' | 'configOptions'> };
  return msg.result;
}

describe('parseHarnessOptions', () => {
  it('parses the cursor fixture mode and model options', () => {
    const { options, modes } = parseHarnessOptions(cursorSessionNewResponse());
    const mode = options.find((o) => o.id === 'mode');
    expect(mode).toBeDefined();
    expect(mode?.choices.map((c) => c.value)).toEqual(['agent', 'plan', 'ask']);
    expect(mode?.currentValue).toBe('agent');

    const model = options.find((o) => o.id === 'model');
    expect(model).toBeDefined();
    expect(model!.choices.length).toBeGreaterThan(0);
    expect(model!.choices.some((c) => c.value === model!.currentValue)).toBe(true);

    expect(modes?.currentModeId).toBe('agent');
    expect(modes?.available.map((m) => m.id)).toEqual(['agent', 'plan', 'ask']);
  });

  it('parses a claude-shaped model and effort list', () => {
    const { options } = parseHarnessOptions({
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default', name: 'Default' }],
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'claude-opus-5',
          options: [{ value: 'claude-opus-5', name: 'Opus' }],
        },
        {
          id: 'effort',
          name: 'Effort',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
        { id: 'ignored', type: 'text', currentValue: 'x' } as unknown as acp.SessionConfigOption,
      ],
    });
    expect(options.map((o) => o.id)).toEqual(['model', 'effort']);
    expect(options[1]?.currentValue).toBe('high');
  });

  it('tolerates missing descriptions and categories', () => {
    const { options } = parseHarnessOptions({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'x',
          options: [{ value: 'x', name: 'X' }],
        },
      ],
    });
    expect(options[0]?.category).toBeNull();
    expect(options[0]?.choices[0]?.description).toBeNull();
  });
});
