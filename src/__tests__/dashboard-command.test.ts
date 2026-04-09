import { describe, expect, it } from 'vitest';
import { resolveDashboardMode } from '../commands/dashboard.js';

describe('resolveDashboardMode', () => {
  it('uses bundled static UI by default', () => {
    expect(resolveDashboardMode({
      port: '4800',
      apiOnly: false,
      open: true,
    })).toBe('static');
  });

  it('uses dev mode when requested', () => {
    expect(resolveDashboardMode({
      port: '4800',
      dev: true,
      apiOnly: false,
      open: false,
    })).toBe('dev');
  });

  it('treats --api-only as server-only', () => {
    expect(resolveDashboardMode({
      port: '4800',
      apiOnly: true,
      open: false,
    })).toBe('server-only');
  });

  it('rejects conflicting dev and server-only flags', () => {
    expect(() => resolveDashboardMode({
      port: '4800',
      dev: true,
      serverOnly: true,
      apiOnly: false,
      open: false,
    })).toThrow('Use either --dev or --server-only');
  });
});
