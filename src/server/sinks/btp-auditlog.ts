/**
 * BTP Audit Log sink for ARC-1.
 *
 * Sends structured audit events to SAP BTP Audit Log Service v2 API.
 * Only activates when running on BTP with an auditlog premium service binding.
 *
 * Maps ARC-1 audit events to BTP Audit Log categories:
 * - security-events: auth failures, scope denials, safety blocks
 * - data-accesses: tool calls that read SAP data
 * - data-modifications: tool calls that write/delete SAP data
 * - configuration-changes: transport releases, activations
 *
 * Authentication uses mTLS (X.509 certificates) via the premium plan binding: the token endpoint
 * (`uaa.certurl`, an `*.authentication.cert.*` host) accepts only a TLS client certificate — there
 * is no client secret for this plan. The binding must therefore be created with x509 credentials;
 * a default (`binding-secret`) binding is rejected at startup instead of being reported as enabled.
 * Tokens are cached with 60s refresh buffer (same pattern as btp.ts connectivity proxy).
 *
 * All writes are fire-and-forget — errors go to stderr, never block tool calls.
 */

import { Agent, fetch } from 'undici';
import type {
  AuditEvent,
  AuthPPCreatedEvent,
  AuthScopeDeniedEvent,
  AuthSharedCreatedEvent,
  DataResponseLimitedEvent,
  McpRateLimitedEvent,
  MultiTargetStageFailedEvent,
  SafetyBlockedEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from '../audit.js';
import type { Logger } from '../logger.js';
import type { LogSink } from './types.js';

/** BTP Audit Log service credentials from VCAP_SERVICES */
export interface BTPAuditLogConfig {
  url: string;
  uaa: {
    url: string;
    certurl: string;
    clientid: string;
    certificate: string;
    key: string;
  };
}

/** Audit log category endpoints */
type AuditCategory = 'security-events' | 'data-accesses' | 'data-modifications' | 'configuration-changes';

/** Categorize tool by its access pattern */
function toolCategory(tool: string): AuditCategory {
  if (['SAPWrite', 'SAPManage'].includes(tool)) return 'data-modifications';
  if (['SAPTransport', 'SAPActivate'].includes(tool)) return 'configuration-changes';
  return 'data-accesses';
}

/** Map ARC-1 event types to BTP Audit Log categories */
function categorize(event: AuditEvent): AuditCategory | null {
  switch (event.event) {
    case 'auth_scope_denied':
    case 'safety_blocked':
    case 'target_resolution_failed':
    case 'pp_exchange_failed':
    case 'shared_auth_failed':
    case 'cloud_connector_access_denied':
    case 'sap_service_unavailable':
    case 'sap_authentication_failed':
    case 'sap_authorization_failed':
    case 'target_policy_denied':
    case 'mcp_rate_limited':
    case 'data_response_limited':
      return 'security-events';

    case 'tool_call_start':
    case 'tool_call_end':
      return toolCategory(event.tool);

    case 'auth_pp_created':
      return event.level === 'error' ? 'security-events' : null;

    case 'auth_shared_created':
      return 'security-events';

    // Don't send http_request, server_start, etc. to BTP audit log
    default:
      return null;
  }
}

/** Binding credential fields the premium plan's mTLS token flow cannot work without. */
const REQUIRED_X509_FIELDS = ['certurl', 'certificate', 'key'] as const;

/**
 * A premium/oauth2 auditlog binding exists but can never authenticate.
 *
 * The broker issues `credential-type: binding-secret` (clientid + clientsecret) unless the instance
 * and the binding were created with x509 parameters. Such a binding has no `certurl`, `certificate`
 * or `key`, and the mTLS token endpoint refuses it — every audit write would fail silently. Thrown
 * from {@link parseBTPAuditLogConfig} so startup reports the problem instead of logging "enabled".
 */
export class BTPAuditLogBindingError extends Error {
  constructor(
    readonly plan: string,
    readonly missing: string[],
    credentialType: string | undefined,
  ) {
    super(
      `BTP Audit Log binding (plan "${plan}", credential-type "${credentialType ?? 'unknown'}") is missing ` +
        `${missing.map((field) => `uaa.${field}`).join(', ')}. The premium plan authenticates over mTLS, so the ` +
        `instance must be created with -c '{"xs-security":{"xsappname":"<unique-per-subaccount>",` +
        `"oauth2-configuration":{"credential-types":["x509"],"grant-types":["client_credentials"]}}}' and bound ` +
        `with -c '{"xsuaa":{"credential-type":"x509","x509":{"key-length":2048,"validity":90,"validity-type":"DAYS"}}}' ` +
        `(MTA: requires[].parameters.config.xsuaa). Rebind and restart; the sink stays disabled until then.`,
    );
    this.name = 'BTPAuditLogBindingError';
  }
}

interface AuditLogBinding {
  plan?: unknown;
  credentials?: { url?: unknown; uaa?: Record<string, unknown> };
}

/**
 * Parse BTP Audit Log credentials from VCAP_SERVICES.
 *
 * Returns undefined if the service is not bound (or VCAP_SERVICES is unreadable). Throws
 * {@link BTPAuditLogBindingError} if a premium/oauth2 binding is present but lacks the x509
 * credentials — the one misconfiguration that would otherwise look like a working sink.
 */
export function parseBTPAuditLogConfig(): BTPAuditLogConfig | undefined {
  const vcap = process.env.VCAP_SERVICES;
  if (!vcap) return undefined;

  let binding: AuditLogBinding | undefined;
  try {
    const services = JSON.parse(vcap);
    // Look for auditlog service with premium plan
    const auditlogEntries = services.auditlog ?? services['auditlog-api'] ?? [];
    binding = Array.isArray(auditlogEntries)
      ? auditlogEntries.find((s: AuditLogBinding) => s.plan === 'premium' || s.plan === 'oauth2')
      : undefined;
  } catch {
    return undefined;
  }

  const creds = binding?.credentials;
  if (!creds) return undefined;

  const uaa = creds.uaa ?? {};
  const missing = REQUIRED_X509_FIELDS.filter((field) => typeof uaa[field] !== 'string' || uaa[field] === '');
  if (missing.length > 0) {
    const credentialType = uaa['credential-type'];
    throw new BTPAuditLogBindingError(
      String(binding?.plan),
      missing,
      typeof credentialType === 'string' ? credentialType : undefined,
    );
  }

  return {
    url: String(creds.url),
    uaa: {
      url: String(uaa.url ?? ''),
      certurl: String(uaa.certurl),
      clientid: String(uaa.clientid ?? ''),
      certificate: String(uaa.certificate),
      key: String(uaa.key),
    },
  };
}

/** The slice of the logger the sink registration needs — keeps the function unit-testable with a stub. */
type SinkRegistrar = Pick<Logger, 'addSink' | 'info' | 'warn' | 'error'>;

/**
 * Attach the BTP Audit Log sink when a usable premium binding is present.
 *
 * No binding → nothing happens (the sink is optional). A bound-but-unusable binding is an
 * operator error worth an ERROR, not an "optional" warning: the deployment expects an audit
 * trail and would otherwise get none, silently. Owned here rather than in server.ts so the
 * startup wiring and the binding contract live next to each other.
 */
export function registerBTPAuditLogSink(logger: SinkRegistrar): void {
  try {
    const config = parseBTPAuditLogConfig();
    if (!config) return;
    logger.addSink(new BTPAuditLogSink(config));
    logger.info('BTP Audit Log sink enabled', { url: config.url });
  } catch (err) {
    if (err instanceof BTPAuditLogBindingError) {
      logger.error('BTP Audit Log sink disabled — the bound service credentials cannot authenticate', {
        error: err.message,
      });
      return;
    }
    logger.warn('BTP Audit Log sink initialization failed (optional)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export class BTPAuditLogSink implements LogSink {
  private token: string | undefined;
  private tokenExpiresAt = 0;
  private pendingWrites: Promise<void>[] = [];
  /** Dispatcher that presents the binding's client certificate to the mTLS token endpoint. */
  private mtlsAgent: Agent | undefined;

  constructor(private config: BTPAuditLogConfig) {}

  write(event: AuditEvent): void {
    const category = categorize(event);
    if (!category) return;

    // Fire-and-forget
    const p = this.sendEvent(event, category).catch((err) => {
      process.stderr.write(`[BTPAuditLogSink] Failed to write audit event: ${err}\n`);
    });
    this.pendingWrites.push(p);

    // Cleanup completed promises periodically
    if (this.pendingWrites.length > 50) {
      this.pendingWrites = this.pendingWrites.filter((p) => {
        let settled = false;
        p.then(
          () => (settled = true),
          () => (settled = true),
        );
        return !settled;
      });
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingWrites);
    this.pendingWrites = [];
  }

  private async sendEvent(event: AuditEvent, category: AuditCategory): Promise<void> {
    const token = await this.getToken();
    const payload = this.buildPayload(event, category);

    const response = await fetch(`${this.config.url}/audit-log/oauth2/v2/${category}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  private buildPayload(event: AuditEvent, category: AuditCategory): Record<string, unknown> {
    const user = event.user ?? '$USER';
    // Security events carry free-text `data`, not attributes — append the calling agent there so a
    // denial or lockout can be attributed to the software that triggered it, not just the user.
    const agent = event.clientAgent ? ` Agent: ${event.clientAgent}.` : '';
    const base: Record<string, unknown> = {
      uuid: crypto.randomUUID(),
      user,
      time: event.timestamp,
      tenant: '$PROVIDER',
    };
    // The Write API rejects data-access and data-modification records without a `data_subject`
    // ("'data_subject' and 'data_subjects' properties cannot be both null or empty", HTTP 400).
    // ARC-1 reads and changes SAP repository/business data on behalf of the caller, so the data
    // subject is the SAP system whose data is touched — identified by the resolved target or
    // destination, or the single configured target when neither is known. Security events and
    // configuration changes do not carry the field (SAP's schema has no place for it there).
    if (category === 'data-accesses' || category === 'data-modifications') {
      base.data_subject = {
        type: 'sap-system',
        role: 'data-owner',
        id: { system: event.target ?? event.destination ?? 'configured-target' },
      };
    }

    switch (event.event) {
      case 'tool_call_start': {
        const e = event as ToolCallStartEvent;
        const argsStr = JSON.stringify(e.args);
        const argsSummary = argsStr.length > 500 ? `${argsStr.slice(0, 500)}...` : argsStr;
        const attrs = [
          { name: 'action', new: 'invoke' },
          { name: 'tool', new: e.tool },
          { name: 'user', new: user },
          { name: 'clientId', new: e.clientId ?? '' },
          { name: 'args', new: argsSummary },
        ];
        // Which agent software acted, next to the registered client it acted under.
        if (e.clientAgent) attrs.push({ name: 'clientAgent', new: e.clientAgent });
        if (e.target) attrs.push({ name: 'target', new: e.target });
        if (e.identity) attrs.push({ name: 'identity', new: e.identity });
        return {
          ...base,
          object: {
            type: 'MCP Tool Call',
            id: { tool: e.tool, requestId: e.requestId ?? '' },
          },
          attributes: attrs,
        };
      }

      case 'tool_call_end': {
        const e = event as ToolCallEndEvent;
        const attrs = [
          { name: 'action', new: 'complete' },
          { name: 'tool', new: e.tool },
          { name: 'user', new: user },
          { name: 'clientId', new: e.clientId ?? '' },
          { name: 'status', new: e.status },
          { name: 'durationMs', new: String(e.durationMs) },
          { name: 'resultSize', new: String(e.resultSize ?? 0) },
        ];
        if (e.errorMessage) {
          attrs.push({ name: 'error', new: e.errorMessage.slice(0, 500) });
        }
        if (e.errorClass) {
          attrs.push({ name: 'errorClass', new: e.errorClass });
        }
        if (e.clientAgent) {
          attrs.push({ name: 'clientAgent', new: e.clientAgent });
        }
        if (e.target) {
          attrs.push({ name: 'target', new: e.target });
        }
        if (e.identity) {
          attrs.push({ name: 'identity', new: e.identity });
        }
        return {
          ...base,
          object: {
            type: 'MCP Tool Call',
            id: { tool: e.tool, requestId: e.requestId ?? '' },
          },
          attributes: attrs,
        };
      }

      case 'auth_scope_denied': {
        const e = event as AuthScopeDeniedEvent;
        const target = e.target ? ` Target: ${e.target}.` : '';
        const identity = e.identity ? ` identity=${e.identity}.` : '';
        return {
          ...base,
          data: `Access denied: user "${user}" lacks scope "${e.requiredScope}" for tool ${e.tool}. Available scopes: [${e.availableScopes.join(', ')}].${target}${identity}${agent}`,
        };
      }

      case 'safety_blocked': {
        const e = event as SafetyBlockedEvent;
        const target = e.target ? ` Target: ${e.target}.` : '';
        const identity = e.identity ? ` identity=${e.identity}.` : '';
        return {
          ...base,
          data: `Safety blocked: operation "${e.operation}" denied — ${e.reason}. User: ${user}.${target}${identity}${agent}`,
        };
      }

      case 'auth_pp_created': {
        const e = event as AuthPPCreatedEvent;
        const route = e.target
          ? `target "${e.target}"`
          : e.destination
            ? `destination "${e.destination}"`
            : 'the configured SAP destination';
        return {
          ...base,
          data: `Principal propagation ${e.success ? 'succeeded' : 'failed'} for user "${user}" via ${route}${e.errorMessage ? `: ${e.errorMessage}` : ''}${e.identity ? ` identity=${e.identity}.` : ''}${agent}`,
        };
      }

      case 'auth_shared_created': {
        const e = event as AuthSharedCreatedEvent;
        return {
          ...base,
          data: `Shared technical SAP authentication succeeded for tool "${e.tool}". User: ${user}.${e.target ? ` Target: ${e.target}.` : ''} identity=shared.${agent}`,
        };
      }

      case 'target_resolution_failed':
      case 'pp_exchange_failed':
      case 'shared_auth_failed':
      case 'cloud_connector_access_denied':
      case 'sap_service_unavailable':
      case 'sap_authentication_failed':
      case 'sap_authorization_failed':
      case 'target_policy_denied': {
        const e = event as MultiTargetStageFailedEvent;
        const target = e.target ? ` Target: ${e.target}.` : '';
        const identity = e.identity ? ` identity=${e.identity}.` : '';
        return {
          ...base,
          data: `Multi-target stage "${e.event}" failed for tool "${e.tool}" with code "${e.errorCode}". User: ${user}.${target}${identity}${agent}`,
        };
      }

      case 'mcp_rate_limited': {
        const e = event as McpRateLimitedEvent;
        const target = e.target ? ` Target: ${e.target}.` : '';
        const identity = e.identity ? ` identity=${e.identity}.` : '';
        return {
          ...base,
          data: `MCP rate limit blocked tool "${e.tool}" at ${e.limitPerMinute}/min; retry after ${e.retryAfterMs}ms. User: ${user}.${target}${identity}${agent}`,
        };
      }

      case 'data_response_limited': {
        const e = event as DataResponseLimitedEvent;
        const target = e.target ? ` Target: ${e.target}.` : '';
        const identity = e.identity ? ` identity=${e.identity}.` : '';
        return {
          ...base,
          data: `Data response limit blocked tool "${e.tool}" at ${e.limitBytes} bytes after observing ${e.observedBytes} bytes; queue wait ${e.queueWaitMs}ms. User: ${user}.${target}${identity}${agent}`,
        };
      }

      default:
        return {
          ...base,
          data: `[${event.event}] ${JSON.stringify(event)}`,
        };
    }
  }

  private async getToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    // The premium plan's token endpoint accepts only mTLS: the binding's client certificate IS
    // the credential, there is no client secret. Without it the `*.authentication.cert.*` host
    // resets the TLS handshake, which undici surfaces as `TypeError: fetch failed`. Node's global
    // fetch cannot present a client certificate, so the request goes through undici's fetch with
    // an Agent that carries the certificate and key from the binding (same undici-fetch rule as
    // `AdtHttpClient.doFetch`: the built-in fetch does not accept npm-undici dispatchers).
    this.mtlsAgent ??= new Agent({ connect: { cert: this.config.uaa.certificate, key: this.config.uaa.key } });
    const tokenUrl = `${this.config.uaa.certurl}/oauth/token`;
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.uaa.clientid,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      dispatcher: this.mtlsAgent,
    }).catch((err: unknown) => {
      throw new Error(
        `Token fetch failed: ${err instanceof Error ? err.message : String(err)} — the mTLS handshake with ` +
          `${this.config.uaa.certurl} was refused; check that the binding is x509 and its certificate has not expired`,
      );
    });

    if (!response.ok) {
      throw new Error(`Token fetch failed: HTTP ${response.status} from ${this.config.uaa.certurl}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.token;
  }
}
