import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DetailPane } from '../DetailPane.js';

describe('DetailPane', () => {
  it('shows a hint when nothing is selected', () => {
    const { lastFrame, unmount } = render(
      <DetailPane projectsDir="/tmp/p" assignmentsDir="/tmp/a" selection={{ kind: 'none' }} />,
    );
    expect(lastFrame() ?? '').toContain('Select an assignment or session');
    unmount();
  });
});
