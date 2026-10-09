import { randomUUID } from 'node:crypto';
import { decodeNativeAlexaDiscovery, type NativeAlexaDiscoveredDeviceV1, type NativeControlV1 } from './dinodiaV1';

type AlexaHeader = { namespace: string; name: string; messageId: string; correlationToken?: string; payloadVersion: string };
type AlexaDirective = {
  header: AlexaHeader;
  endpoint?: { endpointId?: string; scope?: { type?: string; token?: string } };
  payload?: { scope?: { type?: string; token?: string }; [key: string]: unknown };
};
type AlexaEvent = { directive: AlexaDirective };

const CANONICAL_PLATFORM_ORIGIN = 'https://dinodia-platform-v2.vercel.app';
function configuredPlatformOrigin(): string {
  const configured = (process.env.DINODIA_API_BASE_URL || '').replace(/\/$/, '');
  if (!configured) return '';
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new Error('DINODIA_API_BASE_URL must be an absolute HTTPS origin'); }
  if (parsed.origin !== configured || parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash || configured !== CANONICAL_PLATFORM_ORIGIN) {
    throw new Error('DINODIA_API_BASE_URL must use the canonical Native V2 Platform origin');
  }
  return configured;
}
const DINODIA_API_BASE_URL = configuredPlatformOrigin();

class AlexaAuthError extends Error {}
class NativeAlexaUnavailableError extends Error {}

function newMessageId(): string { return `dinodia-${randomUUID()}`; }
function accessTokenFrom(directive: AlexaDirective): string {
  const value = directive.endpoint?.scope?.token ?? directive.payload?.scope?.token;
  return typeof value === 'string' ? value.trim() : '';
}
function errorResponse(directive: AlexaDirective, type: string, message: string, endpointId?: string): object {
  return { event: {
    header: { namespace: 'Alexa', name: 'ErrorResponse', messageId: newMessageId(), correlationToken: directive.header.correlationToken, payloadVersion: '3' },
    ...(endpointId ? { endpoint: { endpointId } } : {}),
    payload: { type, message },
  } };
}
function acceptGrantFailure(directive: AlexaDirective): object {
  return { event: {
    header: { namespace: 'Alexa.Authorization', name: 'ErrorResponse', messageId: newMessageId(), payloadVersion: '3' },
    payload: { type: 'ACCEPT_GRANT_FAILED', message: 'Dinodia could not verify this Alexa permission. Retry linking from the Alexa app.' },
  } };
}
function isNativeEndpointId(value: unknown): value is string { return typeof value === 'string' && /^dos_[A-Za-z0-9_-]{16,80}$/.test(value); }

function supportedInterfaces(device: NativeAlexaDiscoveredDeviceV1): object[] {
  const controls = device.controls.filter((control) => control.writable && control.readable && control.automatable && control.stepUpPolicy !== 'required');
  const result: object[] = [
    { interface: 'Alexa', version: '3' },
    { interface: 'Alexa.EndpointHealth', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'connectivity' }] } },
  ];
  if (controls.some((control) => control.semanticRole === 'power' && control.valueType === 'boolean')) {
    result.push({ interface: 'Alexa.PowerController', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'powerState' }] } });
  }
  if (controls.some((control) => control.semanticRole === 'brightness' && control.valueType === 'number')) {
    result.push({ interface: 'Alexa.BrightnessController', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'brightness' }] } });
  }
  if (controls.some((control) => control.semanticRole === 'target_temperature' && control.valueType === 'number')) {
    result.push({ interface: 'Alexa.ThermostatController', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'targetSetpoint' }] }, configuration: { supportedModes: [{ value: 'HEAT' }] } });
  }
  if (device.controls.some((control) => control.semanticRole === 'ambient_temperature' && control.readable && control.observable && !control.writable)) {
    result.push({ interface: 'Alexa.TemperatureSensor', version: '3', properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'temperature' }] } });
  }
  const position = controls.find((control) => ['opening_percentage', 'position'].includes(control.semanticRole) && control.valueType === 'number' && validRange(control));
  if (position) {
    const bounds = position.constraints!;
    result.push({ interface: 'Alexa.RangeController', version: '3', instance: 'Dinodia.Position', capabilityResources: { friendlyNames: [{ '@type': 'text', value: { text: position.label, locale: 'en-GB' } }] }, properties: { proactivelyReported: true, retrievable: true, supported: [{ name: 'rangeValue' }] }, configuration: { supportedRange: { minimumValue: bounds.minimum, maximumValue: bounds.maximum, precision: bounds.step } }, semantics: { actionMappings: [], stateMappings: [] }, unitOfMeasure: 'Alexa.Unit.Percent' });
  }
  return result;
}
function validRange(control: NativeControlV1): boolean {
  const bounds = control.constraints;
  return !!bounds && Number.isFinite(bounds.minimum) && Number.isFinite(bounds.maximum) && Number.isFinite(bounds.step) && Number(bounds.step) > 0 && Number(bounds.minimum) <= Number(bounds.maximum);
}

async function fetchNativeDiscovery(accessToken: string): Promise<object> {
  if (!DINODIA_API_BASE_URL) throw new Error('DINODIA_API_BASE_URL is not configured');
  const response = await fetch(`${DINODIA_API_BASE_URL}/api/v2/alexa/discovery`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (response.status === 401 || response.status === 403) throw new AlexaAuthError('Alexa authorization failed');
  if (response.status === 501) throw new NativeAlexaUnavailableError('Native Alexa discovery is not activated');
  if (!response.ok) throw new Error(`Native Alexa discovery failed (${response.status})`);
  const projection = decodeNativeAlexaDiscovery(await response.json());
  if (!projection) throw new Error('Platform returned an invalid dinodia.v1 Alexa projection');
  const endpoints = projection.devices.flatMap((device) => {
    const capabilities = supportedInterfaces(device);
    if (capabilities.length === 1) return [];
    return [{ endpointId: device.endpointId, manufacturerName: 'Dinodia', friendlyName: device.friendlyName, description: 'Dinodia Smart Living device', displayCategories: ['OTHER'], capabilities }];
  });
  return { event: { header: { namespace: 'Alexa.Discovery', name: 'Discover.Response', messageId: newMessageId(), payloadVersion: '3' }, payload: { endpoints } } };
}

async function forwardNativeDirective(directive: AlexaDirective, accessToken: string): Promise<unknown> {
  if (!DINODIA_API_BASE_URL) throw new Error('DINODIA_API_BASE_URL is not configured');
  const operation = directive.header.namespace === 'Alexa' && directive.header.name === 'ReportState' ? 'report-state' : 'directives';
  const response = await fetch(`${DINODIA_API_BASE_URL}/api/v2/alexa/${operation}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ directive }),
  });
  if (response.status === 401 || response.status === 403) throw new AlexaAuthError('Alexa authorization failed');
  if (response.status === 501) throw new NativeAlexaUnavailableError('Native Alexa directives are not activated');
  if (!response.ok) throw new Error(`Native Alexa directive failed (${response.status})`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Platform returned an invalid Alexa response');
  return body;
}

async function acceptAlexaGrant(directive: AlexaDirective): Promise<object> {
  if (!DINODIA_API_BASE_URL) return acceptGrantFailure(directive);
  const payload = directive.payload as Record<string, any> | undefined;
  const grant = payload?.grant;
  const grantee = payload?.grantee;
  const messageId = directive.header.messageId;
  if (grant?.type !== 'OAuth2.AuthorizationCode' || typeof grant.code !== 'string' || grant.code.length < 1 || grant.code.length > 4096
      || grantee?.type !== 'BearerToken' || typeof grantee.token !== 'string' || grantee.token.length < 20 || grantee.token.length > 4096
      || typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 180) return acceptGrantFailure(directive);
  try {
    const response = await fetch(`${DINODIA_API_BASE_URL}/api/v2/alexa/accept-grant`, {
      method: 'POST',
      headers: { authorization: `Bearer ${grantee.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ messageId, grantCode: grant.code }),
    });
    if (!response.ok) return acceptGrantFailure(directive);
    const result: unknown = await response.json().catch(() => null);
    if (!result || typeof result !== 'object' || Array.isArray(result) || (result as Record<string, unknown>).accepted !== true) return acceptGrantFailure(directive);
    return { event: {
      header: { namespace: 'Alexa.Authorization', name: 'AcceptGrant.Response', messageId, payloadVersion: '3' },
      payload: {},
    } };
  } catch { return acceptGrantFailure(directive); }
}

/** Native V2 only: all authorization and device authority remains in Platform and the OS. */
export const handler = async (event: any): Promise<any> => {
  if (Array.isArray(event?.Records) && event.Records.some((record: any) => record?.eventSource === 'aws:sqs')) return undefined;
  if (typeof event?.request?.type === 'string' && event.request.type.startsWith('AlexaSkillEvent.')) return {};
  const directive = (event as AlexaEvent)?.directive;
  if (!directive?.header || typeof directive.header.namespace !== 'string' || typeof directive.header.name !== 'string') return {};
  if (directive.header.namespace === 'Alexa.Authorization' && directive.header.name === 'AcceptGrant') return acceptAlexaGrant(directive);
  if (directive.header.namespace === 'Alexa.Discovery' && directive.header.name === 'Discover') {
    const token = accessTokenFrom(directive);
    if (!token) return errorResponse(directive, 'INVALID_AUTHORIZATION_CREDENTIAL', 'A linked Dinodia account is required.');
    try { return await fetchNativeDiscovery(token); }
    catch (error) {
      if (error instanceof AlexaAuthError) return errorResponse(directive, 'INVALID_AUTHORIZATION_CREDENTIAL', 'Authorization failed.');
      if (error instanceof NativeAlexaUnavailableError) return errorResponse(directive, 'NOT_SUPPORTED_IN_CURRENT_MODE', 'Dinodia Alexa features are not enabled in this release.');
      return errorResponse(directive, 'ENDPOINT_UNREACHABLE', 'Dinodia Platform is unavailable.');
    }
  }
  const endpointId = directive.endpoint?.endpointId;
  if (!isNativeEndpointId(endpointId)) return errorResponse(directive, 'NO_SUCH_ENDPOINT', 'This is not a Native V2 endpoint.');
  const token = accessTokenFrom(directive);
  if (!token) return errorResponse(directive, 'INVALID_AUTHORIZATION_CREDENTIAL', 'A linked Dinodia account is required.', endpointId);
  try { return await forwardNativeDirective(directive, token); }
  catch (error) {
    if (error instanceof AlexaAuthError) return errorResponse(directive, 'INVALID_AUTHORIZATION_CREDENTIAL', 'Authorization failed.', endpointId);
    if (error instanceof NativeAlexaUnavailableError) return errorResponse(directive, 'NOT_SUPPORTED_IN_CURRENT_MODE', 'Dinodia Alexa features are not enabled in this release.', endpointId);
    return errorResponse(directive, 'ENDPOINT_UNREACHABLE', 'Dinodia Platform is unavailable.', endpointId);
  }
};
