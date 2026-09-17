import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../../../src/server/audit.js';
import {
  BTPAuditLogBindingError,
  BTPAuditLogSink,
  parseBTPAuditLogConfig,
  registerBTPAuditLogSink,
} from '../../../../src/server/sinks/btp-auditlog.js';

const { fetchMock, agentOptions } = vi.hoisted(() => ({ fetchMock: vi.fn(), agentOptions: [] as unknown[] }));

// The sink goes through undici's fetch + Agent: the mTLS token request needs a dispatcher that
// carries the binding's client certificate, which Node's global fetch cannot take.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  class MockAgent {
    constructor(options: unknown) {
      agentOptions.push(options);
    }
  }
  return { ...actual, fetch: fetchMock, Agent: MockAgent };
});

describe('BTP Audit Log Sink', () => {
  describe('parseBTPAuditLogConfig', () => {
    const originalEnv = process.env.VCAP_SERVICES;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.VCAP_SERVICES;
      } else {
        process.env.VCAP_SERVICES = originalEnv;
      }
    });

    it('returns undefined when VCAP_SERVICES is not set', () => {
      delete process.env.VCAP_SERVICES;
      expect(parseBTPAuditLogConfig()).toBeUndefined();
    });

    it('returns undefined when no auditlog binding exists', () => {
      process.env.VCAP_SERVICES = JSON.stringify({ xsuaa: [] });
      expect(parseBTPAuditLogConfig()).toBeUndefined();
    });

    it('parses premium plan binding', () => {
      process.env.VCAP_SERVICES = JSON.stringify({
        auditlog: [
          {
            plan: 'premium',
            credentials: {
              url: 'https://api.auditlog.cf.example.com:6081',
              uaa: {
                url: 'https://sub.auth.example.com',
                certurl: 'https://sub.auth.cert.example.com',
                clientid: 'my-client-id',
                certificate: '-----BEGIN CERT-----',
                key: '-----BEGIN KEY-----',
              },
            },
          },
        ],
      });

      const config = parseBTPAuditLogConfig();
      expect(config).toBeDefined();
      expect(config!.url).toBe('https://api.auditlog.cf.example.com:6081');
      expect(config!.uaa.clientid).toBe('my-client-id');
    });

    it('returns undefined for invalid JSON', () => {
      process.env.VCAP_SERVICES = 'not-json';
      expect(parseBTPAuditLogConfig()).toBeUndefined();
    });

    it('throws when the premium binding was created without x509 credentials', () => {
      // The broker's default (`credential-type: binding-secret`) yields clientid/clientsecret only.
      // Such a binding can never authenticate against the mTLS token endpoint, so parsing must fail
      // loudly instead of letting startup log "sink enabled" over a sink that writes nothing.
      process.env.VCAP_SERVICES = JSON.stringify({
        auditlog: [
          {
            plan: 'premium',
            credentials: {
              url: 'https://api.auditlog.cf.example.com:6081',
              uaa: {
                url: 'https://sub.auth.example.com',
                clientid: 'my-client-id',
                clientsecret: 'not-usable-for-this-plan',
                'credential-type': 'binding-secret',
              },
            },
          },
        ],
      });

      expect(() => parseBTPAuditLogConfig()).toThrow(BTPAuditLogBindingError);
      expect(() => parseBTPAuditLogConfig()).toThrow(/uaa\.certurl, uaa\.certificate, uaa\.key/);
      expect(() => parseBTPAuditLogConfig()).toThrow(/credential-type "binding-secret"/);
      // The message carries the exact cf parameters an operator needs, so the fix is one copy away.
      expect(() => parseBTPAuditLogConfig()).toThrow(/"credential-type":"x509"/);
    });

    it('names exactly the x509 fields that are missing', () => {
      process.env.VCAP_SERVICES = JSON.stringify({
        auditlog: [
          {
            plan: 'premium',
            credentials: {
              url: 'https://api.auditlog.cf.example.com:6081',
              uaa: {
                certurl: 'https://sub.auth.cert.example.com',
                clientid: 'my-client-id',
                certificate: '-----BEGIN CERT-----',
              },
            },
          },
        ],
      });

      let thrown: unknown;
      try {
        parseBTPAuditLogConfig();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(BTPAuditLogBindingError);
      expect((thrown as BTPAuditLogBindingError).missing).toEqual(['key']);
      expect((thrown as BTPAuditLogBindingError).plan).toBe('premium');
    });
  });

  describe('registerBTPAuditLogSink', () => {
    const originalEnv = process.env.VCAP_SERVICES;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.VCAP_SERVICES;
      } else {
        process.env.VCAP_SERVICES = originalEnv;
      }
    });

    const stubLogger = () => ({
      addSink: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    const x509Binding = (uaa: Record<string, string>) =>
      JSON.stringify({
        auditlog: [{ plan: 'premium', credentials: { url: 'https://api.auditlog.cf.example.com:6081', uaa } }],
      });

    it('does nothing when no auditlog service is bound', () => {
      delete process.env.VCAP_SERVICES;
      const logger = stubLogger();
      registerBTPAuditLogSink(logger);
      expect(logger.addSink).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('registers the sink and reports it enabled for a usable x509 binding', () => {
      process.env.VCAP_SERVICES = x509Binding({
        url: 'https://sub.auth.example.com',
        certurl: 'https://sub.auth.cert.example.com',
        clientid: 'my-client-id',
        certificate: '-----BEGIN CERT-----',
        key: '-----BEGIN KEY-----',
      });
      const logger = stubLogger();
      registerBTPAuditLogSink(logger);
      expect(logger.addSink).toHaveBeenCalledTimes(1);
      expect(logger.addSink.mock.calls[0]![0]).toBeInstanceOf(BTPAuditLogSink);
      expect(logger.info).toHaveBeenCalledWith('BTP Audit Log sink enabled', {
        url: 'https://api.auditlog.cf.example.com:6081',
      });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('reports an unusable binding as an error and does not register the sink', () => {
      // This is the case that used to log "sink enabled" and then write nothing, forever.
      process.env.VCAP_SERVICES = x509Binding({
        url: 'https://sub.auth.example.com',
        clientid: 'my-client-id',
        clientsecret: 'not-usable-for-this-plan',
        'credential-type': 'binding-secret',
      });
      const logger = stubLogger();
      registerBTPAuditLogSink(logger);
      expect(logger.addSink).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [message, context] = logger.error.mock.calls[0]!;
      expect(message).toContain('sink disabled');
      expect(String((context as { error: string }).error)).toContain('uaa.certurl, uaa.certificate, uaa.key');
    });
  });

  describe('Event categorization', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      fetchSpy = fetchMock;
      fetchSpy.mockReset().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'test-token', expires_in: 3600 }),
        text: () => Promise.resolve(''),
      });
      agentOptions.length = 0;
    });

    afterEach(() => {
      stderrSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    const config = {
      url: 'https://api.auditlog.test:6081',
      uaa: {
        url: 'https://sub.auth.test',
        certurl: 'https://sub.auth.cert.test',
        clientid: 'test-client',
        certificate: 'cert',
        key: 'key',
      },
    };

    it('sends security events for auth_scope_denied', async () => {
      const sink = new BTPAuditLogSink(config);
      const event: AuditEvent = {
        timestamp: '',
        level: 'warn',
        event: 'auth_scope_denied',
        tool: 'SAPWrite',
        requiredScope: 'write',
        availableScopes: ['read'],
      };
      sink.write(event);
      await sink.flush();

      // First call is token fetch, second is audit log write
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const auditCall = fetchSpy.mock.calls[1]!;
      expect(auditCall[0]).toContain('/security-events');
    });

    it('requests the token over mTLS with the certificate and key from the binding', async () => {
      const sink = new BTPAuditLogSink(config);
      sink.write({ timestamp: '', level: 'info', event: 'tool_call_start', tool: 'SAPRead', args: {} });
      await sink.flush();

      // The Agent carries the binding's client certificate — without it the premium plan's
      // `*.authentication.cert.*` endpoint resets the handshake and nothing is ever written.
      expect(agentOptions).toEqual([{ connect: { cert: 'cert', key: 'key' } }]);
      const tokenCall = fetchSpy.mock.calls[0]!;
      expect(tokenCall[0]).toBe('https://sub.auth.cert.test/oauth/token');
      const init = tokenCall[1] as { body?: string; dispatcher?: unknown };
      expect(init.dispatcher).toBeDefined();
      expect(init.body).toContain('grant_type=client_credentials');
      expect(init.body).toContain('client_id=test-client');
    });

    it('reuses one mTLS agent across events', async () => {
      const sink = new BTPAuditLogSink(config);
      sink.write({ timestamp: '', level: 'info', event: 'tool_call_start', tool: 'SAPRead', args: {} });
      sink.write({ timestamp: '', level: 'info', event: 'tool_call_start', tool: 'SAPSearch', args: {} });
      await sink.flush();

      expect(agentOptions).toHaveLength(1);
    });

    it('reports a refused mTLS handshake to stderr with the certificate hint', async () => {
      // undici reports a rejected TLS handshake (no/expired client certificate) as `fetch failed`.
      fetchSpy.mockReset().mockRejectedValue(new TypeError('fetch failed'));
      const sink = new BTPAuditLogSink(config);
      sink.write({ timestamp: '', level: 'info', event: 'tool_call_start', tool: 'SAPRead', args: {} });
      await sink.flush();

      const written = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      expect(written).toContain('[BTPAuditLogSink] Failed to write audit event');
      expect(written).toContain('fetch failed');
      expect(written).toContain('certificate has not expired');
    });

    it('reports a rejected token request with the status and endpoint', async () => {
      fetchSpy.mockReset().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });
      const sink = new BTPAuditLogSink(config);
      sink.write({ timestamp: '', level: 'info', event: 'tool_call_start', tool: 'SAPRead', args: {} });
      await sink.flush();

      const written = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      expect(written).toContain('Token fetch failed: HTTP 401 from https://sub.auth.cert.test');
    });

    it('carries a data_subject on data-access records, naming the SAP system by its target', async () => {
      // The Write API rejects data-accesses/data-modifications without `data_subject` (HTTP 400,
      // "'data_subject' and 'data_subjects' properties cannot be both null or empty").
      const sink = new BTPAuditLogSink(config);
      sink.write({
        timestamp: '',
        level: 'info',
        event: 'tool_call_start',
        tool: 'SAPRead',
        target: 'A4H.001',
        args: {},
      });
      await sink.flush();

      const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
      expect(body.data_subject).toEqual({ type: 'sap-system', role: 'data-owner', id: { system: 'A4H.001' } });
    });

    it('falls back to the configured target as data_subject when no target or destination is known', async () => {
      const sink = new BTPAuditLogSink(config);
      sink.write({
        timestamp: '',
        level: 'info',
        event: 'tool_call_end',
        tool: 'SAPWrite',
        durationMs: 1,
        status: 'success',
      });
      await sink.flush();

      const auditCall = fetchSpy.mock.calls[1]!;
      expect(auditCall[0]).toContain('/data-modifications');
      const body = JSON.parse(auditCall[1]!.body as string);
      expect(body.data_subject.id).toEqual({ system: 'configured-target' });
    });

    it('sends no data_subject on security events and configuration changes', async () => {
      const sink = new BTPAuditLogSink(config);
      sink.write({
        timestamp: '',
        level: 'warn',
        event: 'auth_scope_denied',
        tool: 'SAPWrite',
        requiredScope: 'write',
        availableScopes: ['read'],
      });
      sink.write({ timestamp: '', level: 'info', event: 'tool_call_start', tool: 'SAPTransport', args: {} });
      await sink.flush();

      const bodies = fetchSpy.mock.calls
        .filter((call) => String(call[0]).includes('/audit-log/'))
        .map((call) => JSON.parse(call[1]!.body as string));
      expect(bodies).toHaveLength(2);
      for (const body of bodies) expect(body).not.toHaveProperty('data_subject');
    });

    it('sends bounded data-response events without response or SQL bodies', async () => {
      const sink = new BTPAuditLogSink(config);
      sink.write({
        timestamp: '',
        level: 'warn',
        event: 'data_response_limited',
        tool: 'SAPQuery',
        requestId: 'REQ-1',
        limitBytes: 2_097_152,
        observedBytes: 2_097_153,
        endpointFamily: 'data-preview',
        queueWaitMs: 4,
      });
      await sink.flush();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const auditCall = fetchSpy.mock.calls[1]!;
      expect(auditCall[0]).toContain('/security-events');
      const body = String(auditCall[1]?.body);
      expect(body).toContain('2097152 bytes');
      expect(body).not.toContain('SELECT');
      expect(body).not.toContain('responseBody');
    });

    it('attributes the calling agent on tool-call events', async () => {
      const sink = new BTPAuditLogSink(config);
      sink.write({
        timestamp: '',
        level: 'info',
        event: 'tool_call_start',
        tool: 'SAPRead',
        clientId: 'arc1-abc',
        clientAgent: 'claude-code/1.2.3',
        args: {},
      });
      await sink.flush();

      const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
      expect(body.attributes).toContainEqual({ name: 'clientAgent', new: 'claude-code/1.2.3' });
    });

    it('attributes the calling agent on security events (free-text data, not attributes)', async () => {
      const sink = new BTPAuditLogSink(config);
      sink.write({
        timestamp: '',
        level: 'warn',
        event: 'safety_blocked',
        operation: 'SAPWrite',
        reason: 'Action denied by SAP_DENY_ACTIONS',
        user: 'DEV1',
        clientAgent: 'cursor/0.44.1',
      });
      await sink.flush();

      const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
      expect(body.data).toContain('Agent: cursor/0.44.1.');
    });

    it('omits the agent suffix when no agent was resolved', async () => {
      const sink = new BTPAuditLogSink(config);
      sink.write({
        timestamp: '',
        level: 'warn',
        event: 'safety_blocked',
        operation: 'SAPWrite',
        reason: 'blocked',
        user: 'DEV1',
      });
      await sink.flush();

      const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
      expect(body.data).not.toContain('Agent:');
    });

    it('sends data-accesses for read tool calls', async () => {
      const sink = new BTPAuditLogSink(config);
      const event: AuditEvent = {
        timestamp: '',
        level: 'info',
        event: 'tool_call_end',
        tool: 'SAPRead',
        durationMs: 100,
        status: 'success',
      };
      sink.write(event);
      await sink.flush();

      const auditCall = fetchSpy.mock.calls[1]!;
      expect(auditCall[0]).toContain('/data-accesses');
    });

    it('sends data-modifications for write tool calls', async () => {
      const sink = new BTPAuditLogSink(config);
      const event: AuditEvent = {
        timestamp: '',
        level: 'info',
        event: 'tool_call_end',
        tool: 'SAPWrite',
        durationMs: 200,
        status: 'success',
      };
      sink.write(event);
      await sink.flush();

      const auditCall = fetchSpy.mock.calls[1]!;
      expect(auditCall[0]).toContain('/data-modifications');
    });

    it('sends configuration-changes for transport tool calls', async () => {
      const sink = new BTPAuditLogSink(config);
      const event: AuditEvent = {
        timestamp: '',
        level: 'info',
        event: 'tool_call_end',
        tool: 'SAPTransport',
        durationMs: 300,
        status: 'success',
      };
      sink.write(event);
      await sink.flush();

      const auditCall = fetchSpy.mock.calls[1]!;
      expect(auditCall[0]).toContain('/configuration-changes');
    });

    it('sends every multi-target failure stage with direct target attribution', async () => {
      const sink = new BTPAuditLogSink(config);
      const stages = [
        'target_resolution_failed',
        'pp_exchange_failed',
        'shared_auth_failed',
        'cloud_connector_access_denied',
        'sap_service_unavailable',
        'sap_authentication_failed',
        'sap_authorization_failed',
        'target_policy_denied',
      ] as const;
      for (const event of stages) {
        sink.write({
          timestamp: '',
          level: 'warn',
          event,
          target: 'A4H/100',
          tool: 'SAPRead',
          errorCode: 'VALIDATION_ERROR',
        });
      }
      await sink.flush();

      const auditCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/audit-log/'));
      expect(auditCalls).toHaveLength(stages.length);
      for (const auditCall of auditCalls) {
        expect(auditCall[0]).toContain('/security-events');
        expect(String(auditCall[1]?.body)).toContain('A4H/100');
        expect(String(auditCall[1]?.body)).toContain('VALIDATION_ERROR');
      }
    });

    it('preserves target attribution across forwarded multi-target event families', async () => {
      const sink = new BTPAuditLogSink(config);
      const target = 'A4H/100';
      const events: AuditEvent[] = [
        {
          timestamp: '',
          level: 'info',
          event: 'tool_call_start',
          target,
          identity: 'shared',
          tool: 'SAPRead',
          args: {},
        },
        {
          timestamp: '',
          level: 'info',
          event: 'tool_call_end',
          target,
          identity: 'shared',
          tool: 'SAPRead',
          durationMs: 1,
          status: 'success',
        },
        {
          timestamp: '',
          level: 'error',
          event: 'auth_pp_created',
          target,
          identity: 'per-user',
          success: false,
          errorMessage: 'redacted upstream',
        },
        {
          timestamp: '',
          level: 'info',
          event: 'auth_shared_created',
          target,
          user: 'TEST_USER',
          tool: 'SAPRead',
          identity: 'shared',
        },
        {
          timestamp: '',
          level: 'warn',
          event: 'auth_scope_denied',
          target,
          identity: 'shared',
          tool: 'SAPQuery',
          requiredScope: 'sql',
          availableScopes: ['read'],
        },
        {
          timestamp: '',
          level: 'warn',
          event: 'safety_blocked',
          target,
          identity: 'shared',
          operation: 'SAPWrite',
          reason: 'read-only multi-target v1',
        },
        {
          timestamp: '',
          level: 'warn',
          event: 'mcp_rate_limited',
          target,
          identity: 'shared',
          user: 'TEST_USER',
          tool: 'SAPRead',
          limitPerMinute: 120,
          retryAfterMs: 500,
        },
      ];
      for (const event of events) sink.write(event);
      await sink.flush();

      const auditCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/audit-log/'));
      expect(auditCalls).toHaveLength(events.length);
      for (const auditCall of auditCalls) {
        const body = String(auditCall[1]?.body);
        expect(body).toContain(target);
        expect(body).toContain('identity');
        expect(body).not.toContain('undefined');
      }
    });

    it('does not send http_request events', async () => {
      const sink = new BTPAuditLogSink(config);
      const event: AuditEvent = {
        timestamp: '',
        level: 'debug',
        event: 'http_request',
        method: 'GET',
        path: '/test',
        statusCode: 200,
        durationMs: 50,
      };
      sink.write(event);
      await sink.flush();

      // Only token fetch should happen, no audit log write
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    it('does not send server_start events', async () => {
      const sink = new BTPAuditLogSink(config);
      const event: AuditEvent = {
        timestamp: '',
        level: 'info',
        event: 'server_start',
        version: '3.0.0',
        transport: 'stdio',
        allowWrites: true,
        url: 'http://test',
      };
      sink.write(event);
      await sink.flush();

      expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    it('handles fetch errors gracefully (fire-and-forget)', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));
      const sink = new BTPAuditLogSink(config);
      const event: AuditEvent = {
        timestamp: '',
        level: 'warn',
        event: 'safety_blocked',
        operation: 'CreateObject',
        reason: 'allowWrites=false',
      };
      sink.write(event);

      // Should not throw
      await sink.flush();
      // Error should be logged to stderr
      expect(stderrSpy).toHaveBeenCalled();
    });
  });
});
