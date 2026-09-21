import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  findCreateChatBrokerGuardViolations,
  scanTestTree,
} from './helpers/broker-test-guard-scan.js';

describe('broker test guard', () => {
  it('flags a createChatBroker call without commandResolver', () => {
    const bad = `
      createChatBroker({
        projectsDir: '/tmp',
      });
    `;
    expect(findCreateChatBrokerGuardViolations(bad, 'snippet')).toEqual(['snippet:2']);
  });

  it('accepts a compliant call and the ignore marker', () => {
    const good = `
      createChatBroker({
        commandResolver: fakeCommandResolver,
        projectsDir: '/tmp',
      });
      createChatBroker(opts); // broker-test-guard: ignore
    `;
    expect(findCreateChatBrokerGuardViolations(good, 'snippet')).toEqual([]);
  });

  it('every test createChatBroker passes commandResolver', async () => {
    const root = join(import.meta.dirname, '.');
    const violations = await scanTestTree(root);
    expect(violations).toEqual([]);
  });
});
