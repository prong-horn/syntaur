import TestRenderer, { act } from 'react-test-renderer';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LegacyRedirect,
  WorkspacePrefixRedirect,
  legacyDestinationToLocation,
} from '../LegacyRedirect';

function LocationEcho() {
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}${location.hash}`}</output>;
}

describe('LegacyRedirect', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps legacy destinations into pathname/search/hash fields', () => {
    expect(legacyDestinationToLocation('/board?status=review#x')).toEqual({
      pathname: '/board',
      search: '?status=review',
      hash: '#x',
    });
  });

  it('preserves hash fragments through Navigate', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={['/tickets?status=review#x']}>
          <Routes>
            <Route path="/tickets" element={<LegacyRedirect />} />
            <Route path="/board" element={<LocationEcho />} />
          </Routes>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    expect(renderer.root.findByType('output').children.join('')).toBe('/board?status=review#x');
    await act(async () => renderer.unmount());
  });

  it('preserves hash through workspace prefix strip', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryRouter initialEntries={['/w/ws-1/tickets?status=review#x']}>
          <Routes>
            <Route path="/w/:workspace/*" element={<WorkspacePrefixRedirect />} />
            <Route path="/tickets" element={<LegacyRedirect />} />
            <Route path="/board" element={<LocationEcho />} />
          </Routes>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    expect(renderer.root.findByType('output').children.join('')).toBe('/board?status=review#x');
    await act(async () => renderer.unmount());
  });
});
