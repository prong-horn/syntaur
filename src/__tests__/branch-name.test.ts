import { describe, it, expect } from 'vitest';
import { validateBranchName } from '../utils/branch-name.js';

describe('validateBranchName', () => {
  const valid = ['main', 'syntaur/foo/bar', 'feature/x_1', 'release-1.2', 'a'];
  const invalid = [
    '',
    '  ',
    'has space',
    '-foo',
    'foo/.bar',
    'foo//bar',
    '/foo',
    'foo/',
    'foo.',
    'foo..bar',
    'foo@{1}',
    'foo~1',
    'foo^',
    'foo:bar',
    'foo?',
    'foo*',
    'foo[',
    'foo\\bar',
    'foo.lock',
    'a/b.lock',
    '@',
  ];

  for (const name of valid) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(validateBranchName(name)).toBeNull();
    });
  }

  for (const name of invalid) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(validateBranchName(name)).not.toBeNull();
    });
  }
});
