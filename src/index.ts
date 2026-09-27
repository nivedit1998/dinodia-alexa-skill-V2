import { randomUUID } from 'node:crypto';
import { decodeNativeAlexaDiscovery, alexaEndpointId, type NativeControlV1, type NativeDeviceV1 } from './dinodiaV1';

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
function authorizationUnavailable(directive: AlexaDirective): object {
  return { event: {
    header: { namespace: 'Alexa.Authorization', name: 'AuthorizationError', messageId: newMessageId(), payloadVersion: '3' },
    payload: { type: 'INVALID_AUTHORIZATION_CREDENTIAL', message: 'Dinodia Alexa account linking is not enabled in this release.' },
  } };
}
function isNativeEndpointId(value: unknown): value is string { return typeof value === 'string' && /^dos_[a-f0-9]{64}$/.test(value); }

function supportedInterfaces(device: NativeDeviceV1): object[] {
  const controls = device.controls.filter((control) => control.writable && control.readable && control.automatable && control.stepUpPolicy !== 'required');
  const result: object[] = [{ interface: 'Alexa', version: '3' }];
  if (controls.some((control) => control.semanticRole === 'power' && control.valueType === 'boolean')) {
    result.push({ interface: 'Alexa.PowerController', version: '3', properties: { proactivelyReported: false, retrievable: true, supported: [{ name: 'powerState' }] } });
  }
  if (controls.some((control) => control.semanticRole === 'brightness' && control.valueType === 'number')) {
    result.push({ interface: 'Alexa.BrightnessController', version: '3', properties: { proactivelyReported: false, retrievable: true, supported: [{ name: 'brightness' }] } });
  }
  const position = controls.find((control) => ['opening_percentage', 'position'].includes(control.semanticRole) && control.valueType === 'number' && validRange(control));
  if (position) {
    const bounds = position.constraints!;
    result.push({ interface: 'Alexa.RangeController', version: '3', instance: 'Dinodia.Position', capabilityResources: { friendlyNames: [{ '@type': 'text', value: { text: position.label, locale: 'en-GB' } }] }, properties: { proactivelyReported: false, retrievable: true, supported: [{ name: 'rangeValue' }] }, configuration: { supportedRange: { minimumValue: bounds.minimum, maximumValue: bounds.maximum, precision: bounds.step } }, semantics: { actionMappings: [], stateMappings: [] }, unitOfMeasure: 'Alexa.Unit.Percent' });
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
  if (response.status === 501) throw new NativeAlexaUnavailableError('Native Alexa discovery is disabled in Stage 2');
  if (!response.ok) throw new Error(`Native Alexa discovery failed (${response.status})`);
  const projection = decodeNativeAlexaDiscovery(await response.json());
  if (!projection) throw new Error('Platform returned an invalid dinodia.v1 Alexa projection');
  const endpoints = projection.devices.flatMap((device) => {
    const capabilities = supportedInterfaces(device);
    if (capabilities.length === 1) return [];
    return [{ endpointId: alexaEndpointId(projection.homeId, device.id), manufacturerName: 'Dinodia', friendlyName: device.customerLabel || device.technicalLabel, description: 'Dinodia Smart Living device', displayCategories: ['OTHER'], capabilities }];
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
  if (response.status === 501) throw new NativeAlexaUnavailableError('Native Alexa directives are disabled in Stage 2');
  if (!response.ok) throw new Error(`Native Alexa directive failed (${response.status})`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Platform returned an invalid Alexa response');
  return body;
}

/** Stage 2 adapter only: no account linking, legacy endpoints, HA identifiers, queue jobs, or fallback. */
export const handler = async (event: any): Promise<any> => {
  if (Array.isArray(event?.Records) && event.Records.some((record: any) => record?.eventSource === 'aws:sqs')) return undefined;
  if (typeof event?.request?.type === 'string' && event.request.type.startsWith('AlexaSkillEvent.')) return {};
  const directive = (event as AlexaEvent)?.directive;
  if (!directive?.header || typeof directive.header.namespace !== 'string' || typeof directive.header.name !== 'string') return {};
  if (directive.header.namespace === 'Alexa.Authorization' && directive.header.name === 'AcceptGrant') return authorizationUnavailable(directive);
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
