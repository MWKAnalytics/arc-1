import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { unrestrictedSafetyConfig } from '../../../src/adt/safety.js';
import { logger } from '../../../src/server/logger.js';
import { mockResponse } from '../../helpers/mock-fetch.js';

const mockFetch = vi.fn();
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

const { AdtClient } = await import('../../../src/adt/client.js');

const fixturesDir = join(import.meta.dirname, '../../fixtures/xml');
const loadFixture = (name: string): string => readFileSync(join(fixturesDir, name), 'utf8');

function createClient(overrides: Record<string, unknown> = {}): InstanceType<typeof AdtClient> {
  return new AdtClient({ baseUrl: 'http://sap:8000', safety: unrestrictedSafetyConfig(), ...overrides });
}

function objectSearchResponse(uri: string, type: string, name: string): Response {
  return mockResponse(
    200,
    '<?xml version="1.0"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
      `<adtcore:objectReference adtcore:uri="${uri}" adtcore:type="${type}" adtcore:name="${name}"/>` +
      '</adtcore:objectReferences>',
  );
}

/**
 * The sensitive list through the real client: exact direct names, zero SAP calls before the decision,
 * the blocklist winning on overlap, and the justification landing in the policy audit event.
 */
describe('experimental sensitive data-source list', () => {
  const sensitiveSafety = (sensitiveDataSources: string[], blockedDataSources: string[] = []) => ({
    ...unrestrictedSafetyConfig(),
    blockedDataSources,
    sensitiveDataSources,
  });
  const policyDecisions = (spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
    spy.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .filter((event) => event.event === 'data_source_policy_decision');

  it.each([
    ['TABLE_CONTENTS', (client: InstanceType<typeof AdtClient>) => client.getTableContents('KNA1')],
    ['TABLE_QUERY', (client: InstanceType<typeof AdtClient>) => client.runTableQuery('KNA1')],
    ['SAPQuery', (client: InstanceType<typeof AdtClient>) => client.runQuery('SELECT * FROM KNA1')],
    [
      'SAPQuery join with a sensitive second source',
      (client: InstanceType<typeof AdtClient>) =>
        client.runQuery('SELECT * FROM SCARR AS a INNER JOIN KNA1 AS b ON a~MANDT = b~MANDT'),
    ],
  ])('pauses %s without any SAP request when no justification is given', async (_label, call) => {
    mockFetch.mockReset();
    const auditSpy = vi.spyOn(logger, 'emitAudit').mockImplementation(() => undefined);
    try {
      const client = createClient({ safety: sensitiveSafety(['KNA1']) });
      await expect(call(client)).rejects.toMatchObject({
        code: 'DATA_SOURCE_SENSITIVE',
        sourcePath: ['KNA1'],
        executed: false,
      });
      expect(mockFetch).not.toHaveBeenCalled();
      const [decision] = policyDecisions(auditSpy);
      expect(decision).toMatchObject({
        decision: 'deny',
        code: 'DATA_SOURCE_SENSITIVE',
        executed: false,
        matchedSource: 'KNA1',
      });
      // The denial records the direct roots even for free SQL, where they are only known after parsing.
      expect(decision?.directRoots).toContain('KNA1');
    } finally {
      auditSpy.mockRestore();
    }
  });

  it('runs a justified request without lineage traffic and records sources and justification', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(mockResponse(200, loadFixture('table-contents.xml'), { 'x-csrf-token': 'T' }));
    const auditSpy = vi.spyOn(logger, 'emitAudit').mockImplementation(() => undefined);
    try {
      const client = createClient({ safety: sensitiveSafety(['KNA1']) });
      const result = await client.runTableQuery('KNA1', {
        columns: ['KUNNR'],
        justification: '  Ticket INC-4711:\n customer master audit  ',
      });
      expect(result.columns.length).toBeGreaterThan(0);
      const urls = mockFetch.mock.calls.map((call) => String(call[0]));
      expect(urls.filter((url) => url.includes('/datapreview/freestyle'))).toHaveLength(1);
      expect(urls.some((url) => url.includes('/repository/informationsystem/') || url.includes('/ddic/'))).toBe(false);
      const [decision] = policyDecisions(auditSpy);
      expect(decision).toMatchObject({
        decision: 'allow',
        executed: true,
        directRoots: ['KNA1'],
        sensitiveSources: ['KNA1'],
        justification: 'Ticket INC-4711: customer master audit',
        metadataRequests: 0,
      });
    } finally {
      auditSpy.mockRestore();
    }
  });

  it('treats a whitespace-only justification as absent', async () => {
    mockFetch.mockReset();
    const client = createClient({ safety: sensitiveSafety(['KNA1']) });
    await expect(client.runQuery('SELECT * FROM KNA1', 10, { justification: ' \n ' })).rejects.toMatchObject({
      code: 'DATA_SOURCE_SENSITIVE',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('records no sensitive fields for a request that touches no listed source', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(mockResponse(200, loadFixture('table-contents.xml'), { 'x-csrf-token': 'T' }));
    const auditSpy = vi.spyOn(logger, 'emitAudit').mockImplementation(() => undefined);
    try {
      const client = createClient({ safety: sensitiveSafety(['KNA1']) });
      await client.runTableQuery('SCARR', { justification: 'unused' });
      const [decision] = policyDecisions(auditSpy);
      expect(decision).toMatchObject({ decision: 'allow', directRoots: ['SCARR'] });
      expect(decision).not.toHaveProperty('sensitiveSources');
      expect(decision).not.toHaveProperty('justification');
    } finally {
      auditSpy.mockRestore();
    }
  });

  it('lets the blocklist win over the sensitive list, justification or not', async () => {
    mockFetch.mockReset();
    const client = createClient({ safety: sensitiveSafety(['USR02'], ['USR02']) });
    await expect(client.runQuery('SELECT * FROM USR02', 10, { justification: 'still denied' })).rejects.toMatchObject({
      code: 'DATA_SOURCE_BLOCKED',
      sourcePath: ['USR02'],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a TABLE_CONTENTS sqlFilter in sensitive-only mode, pointing at TABLE_QUERY', async () => {
    mockFetch.mockReset();
    const client = createClient({ safety: sensitiveSafety(['KNA1']) });
    await expect(client.getTableContents('SCARR', 10, "CARRID = 'LH'")).rejects.toMatchObject({
      code: 'DATA_SQL_UNSUPPORTED',
      sourcePath: ['SCARR'],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('pauses before any lineage traffic when both lists are active and no justification is given', async () => {
    mockFetch.mockReset();
    const client = createClient({ safety: sensitiveSafety(['KNA1'], ['USR02']) });
    await expect(client.runTableQuery('KNA1')).rejects.toMatchObject({ code: 'DATA_SOURCE_SENSITIVE' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still resolves blocklist lineage for a justified sensitive request when both lists are active', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(objectSearchResponse('/sap/bc/adt/ddic/tables/KNA1', 'TABL/DT', 'KNA1'));
    const client = createClient({ safety: sensitiveSafety(['KNA1'], ['USR02']) });
    // A non-table entry means discovery is loaded while proving the table collection is absent.
    client.http.setDiscoveryMap(new Map([['/sap/bc/adt/ddic/structures', ['text/plain']]]));
    await expect(client.runTableQuery('KNA1', { justification: 'audit' })).rejects.toMatchObject({
      code: 'DATA_POLICY_UNAVAILABLE',
      sourcePath: ['KNA1'],
    });
    const urls = mockFetch.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/repository/informationsystem/search'))).toBe(true);
    expect(urls.some((url) => url.includes('/datapreview/'))).toBe(false);
  });
});
