import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/server/types.js';
import { mockResponse } from '../../helpers/mock-fetch.js';
import { createClient, mockFetch } from './setup-undici-mock.js';

const { handleToolCall } = await import('../../../src/handlers/dispatch.js');
const { resetCachedFeatures, setCachedFeatures } = await import('../../../src/handlers/feature-cache.js');

// SAP_BASIS 7.50 feed: atom:updated 2026-10-24T08:19:08Z, so the older handler listed from 2026-10-23T08:19:08Z.
const feed750 = readFileSync(new URL('../../fixtures/xml/dumps-feed-nw750.xml', import.meta.url), 'utf8');
const EMPTY_FEED =
  '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:updated>2026-10-28T08:30:00Z</atom:updated></atom:feed>';

function mockFeed(feed: string) {
  mockFetch.mockImplementation(async () => mockResponse(200, feed));
}

const list = (args: Record<string, unknown> = {}) =>
  handleToolCall(createClient(), DEFAULT_CONFIG, 'SAPDiagnose', { action: 'dumps', ...args });

beforeEach(() => {
  vi.restoreAllMocks();
  resetCachedFeatures();
  mockFetch.mockReset();
});

describe('SAPDiagnose dump list on a release with the 24-hour dump feed', () => {
  it('keeps the JSON array and adds the window note as a second block', async () => {
    setCachedFeatures({ abapRelease: '750' });
    mockFeed(feed750);
    const result = await list();

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    const dumps = JSON.parse(result.content[0]!.text);
    expect(dumps.map((dump: { error: string }) => dump.error)).toEqual([
      'DDIC_TYPE_INCONSISTENCY',
      'COMPUTE_INT_ZERODIVIDE',
    ]);
    expect(result.content[1]!.text).toContain('SAP_BASIS 7.50');
    expect(result.content[1]!.text).toContain('since 2026-10-23T08:19:08Z)');
    expect(result.content[1]!.text).not.toContain('authorization');
  });

  it('mentions authorization when the cut list is empty', async () => {
    setCachedFeatures({ abapRelease: '750' });
    mockFeed(EMPTY_FEED);
    const result = await list({ from: '2026-10-01T00:00:00Z' });

    expect(JSON.parse(result.content[0]!.text)).toEqual([]);
    expect(result.content[1]!.text).toContain('since 2026-10-27T08:30:00Z)');
    expect(result.content[1]!.text).toContain('ST22 display authorization');
  });

  it('adds nothing when from lies inside the window', async () => {
    setCachedFeatures({ abapRelease: '750' });
    mockFeed(feed750);
    const result = await list({ from: '2026-10-24T00:00:00Z' });
    expect(result.content).toHaveLength(1);
  });

  it('adds nothing on 7.53 and later or before the release is known', async () => {
    mockFeed(EMPTY_FEED);
    expect((await list({ from: '2026-10-01T00:00:00Z' })).content).toHaveLength(1);

    setCachedFeatures({ abapRelease: '758' });
    expect((await list({ from: '2026-10-01T00:00:00Z' })).content).toHaveLength(1);
  });
});
