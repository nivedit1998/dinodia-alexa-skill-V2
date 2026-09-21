// Architecture: Alexa Smart Home skill module src/index.ts; maps Alexa discovery, control, account-linking or state-reporting events to the platform Alexa endpoints.
// src/index.ts
// Alexa Smart Home skill for Dinodia → talks to dinodia-platform backend.
//
// Architecture boundary: Alexa sends discovery, control and state-report
// directives here. This handler translates them to the platform Alexa API and
// preserves the endpoint/capability identifiers expected by both deployments;
// it does not talk directly to Home Assistant.
//
// Assumes:
// - env DINODIA_API_BASE_URL is set (e.g. https://app.dinodia.com)
// - Backend exposes:
//   GET  /api/alexa/devices          (Authorization: Bearer <accessToken>)
//   POST /api/alexa/device-control   (Authorization: Bearer <accessToken>)
//     { entityId: string, command: string, value?: number }

type UIDevice = {
  entityId: string;
  name: string;
  state: string;
  area?: string | null;
  areaName?: string | null;
  label?: string | null;
  labelCategory?: string | null;
  labels?: string[];
  domain: string;
  attributes: Record<string, unknown>;
  servicesForTarget?: string[];
};

type AlexaEntityCapabilityProfile = {
  canPower: boolean;
  canBrightness: boolean;
  canColor: boolean;
  canColorTemperature: boolean;
  canPlayback: boolean;
  canVolume: boolean;
  canTemperature: boolean;
};

function getPrimaryLabel(device: UIDevice): string {
  const labels = Array.isArray(device.labels) ? device.labels : [];
  const fromLabels = labels.find((l) => !!l) ?? null;
  const fromCategory = device.labelCategory ?? null;
  const fromLabel = device.label ?? null;

  const raw =
    (fromCategory && String(fromCategory)) ||
    (fromLabel && String(fromLabel)) ||
    (fromLabels && String(fromLabels)) ||
    '';

  return raw.trim();
}

function isBlindLabel(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'blind';
}

function isBlindDevice(device: UIDevice): boolean {
  if (isBlindLabel(device.label) || isBlindLabel(device.labelCategory)) {
    return true;
  }

  const labels = Array.isArray(device.labels) ? device.labels : [];
  return labels.some((label) => isBlindLabel(label));
}

function getBlindEntityId(device: UIDevice): string {
  const attrs = device.attributes || {};
  const candidates = [
    (attrs as Record<string, unknown>)['target_cover'],
    (attrs as Record<string, unknown>)['cover_entity_id'],
    (attrs as Record<string, unknown>)['coverEntityId'],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.startsWith('cover.')) {
      return candidate;
    }
  }

  if (typeof device.entityId === 'string' && device.entityId.startsWith('cover.')) {
    return device.entityId;
  }

  return device.entityId;
}

const ENDPOINT_ID_PREFIX = 'ha_';

function base64UrlEncode(value: string): string {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string | null {
  if (!value) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function isValidHaEntityId(value: string): boolean {
  return /^([a-zA-Z0-9_]+)\.([a-zA-Z0-9_-]+)$/.test(value);
}

function encodeEndpointId(entityId: string): string {
  return `${ENDPOINT_ID_PREFIX}${base64UrlEncode(entityId)}`;
}

function decodeEndpointId(endpointId: string): string | null {
  if (typeof endpointId !== 'string' || !endpointId.startsWith(ENDPOINT_ID_PREFIX)) {
    return null;
  }
  const decoded = base64UrlDecode(endpointId.slice(ENDPOINT_ID_PREFIX.length));
  if (!decoded || !isValidHaEntityId(decoded)) return null;
  return decoded;
}

function sanitizeFriendlyName(raw: string): string {
  const cleaned = String(raw ?? '')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Device';
}

function deviceMatchesHaEntityId(device: UIDevice, entityId: string): boolean {
  if (device.entityId === entityId) return true;
  if (isBlindDevice(device) && getBlindEntityId(device) === entityId) return true;
  return false;
}

function getHaEntityIdFromDirective(directive: AlexaDirective): string | null {
  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) return null;

  const cookieEntityId = (directive.endpoint as any)?.cookie?.entityId;
  if (typeof cookieEntityId === 'string' && isValidHaEntityId(cookieEntityId.trim())) {
    return cookieEntityId.trim();
  }

  const decoded = decodeEndpointId(endpointId);
  if (decoded) return decoded;

  if (isValidHaEntityId(endpointId)) return endpointId;
  return null;
}

type AlexaDirective = {
  header: {
    namespace: string;
    name: string;
    messageId: string;
    correlationToken?: string;
    instance?: string;
    payloadVersion: string;
  };
  endpoint?: {
    endpointId: string;
    scope?: { type: string; token: string };
  };
  payload?: any;
};

type AlexaEvent = {
  directive: AlexaDirective;
};

const DINODIA_API_BASE_URL =
  (process.env.DINODIA_API_BASE_URL || '').replace(/\/$/, '');

const DINODIA_BACKEND_BASE_URL =
  (process.env.DINODIA_BACKEND_BASE_URL || '').replace(/\/$/, '');

const ALEXA_EVENTS_INTERNAL_SECRET =
  process.env.ALEXA_EVENTS_INTERNAL_SECRET || '';

const ALEXA_SKILL_EVENTS_INTERNAL_SECRET =
  process.env.ALEXA_SKILL_EVENTS_INTERNAL_SECRET || '';

const SAFE_HOMEASSISTANT_SERVICES = new Set([
  'homeassistant.turn_on',
  'homeassistant.turn_off',
  'homeassistant.toggle',
]);

function newMessageId(): string {
  return 'msg-' + Math.random().toString(36).slice(2);
}

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getDeviceServices(device: UIDevice): string[] {
  return Array.isArray(device.servicesForTarget)
    ? device.servicesForTarget.filter((service): service is string => typeof service === 'string')
    : [];
}

function hasService(device: UIDevice, ...serviceIds: string[]) {
  const services = new Set(getDeviceServices(device));
  return serviceIds.some((serviceId) => services.has(serviceId));
}

function inferEntityCapabilityProfile(device: UIDevice): AlexaEntityCapabilityProfile {
  const services = getDeviceServices(device);
  const has = (...serviceIds: string[]) => serviceIds.some((serviceId) => services.includes(serviceId));
  const attrs = (device.attributes ?? {}) as Record<string, unknown>;
  const supportedColorModes = Array.isArray(device.attributes?.supported_color_modes)
    ? device.attributes.supported_color_modes.filter((mode): mode is string => typeof mode === 'string')
    : [];
  const lightIsOnOffOnly =
    supportedColorModes.length === 1 && supportedColorModes[0] === 'onoff';
  const lightCanColor = supportedColorModes.some((m) =>
    ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(String(m).toLowerCase())
  );
  const lightCanColorTemperature = supportedColorModes.some((m) =>
    ['color_temp', 'color_temperature'].includes(String(m).toLowerCase())
  );

  if (isBlindDevice(device)) {
    return {
      canPower: true,
      canBrightness: false,
      canColor: false,
      canColorTemperature: false,
      canPlayback: false,
      canVolume: false,
      canTemperature: false,
    };
  }

  switch (device.domain) {
    case 'light':
      return {
        // For HA lights, assume on/off works even if `servicesForTarget` isn't present.
        canPower: true,
        canBrightness: !lightIsOnOffOnly,
        canColor: lightCanColor,
        canColorTemperature: lightCanColorTemperature,
        canPlayback: false,
        canVolume: false,
        canTemperature: false,
      };
    case 'switch':
      return {
        // For HA switches, assume on/off works even if `servicesForTarget` isn't present.
        canPower: true,
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: false,
        canVolume: false,
        canTemperature: false,
      };
    case 'media_player':
      return {
        canPower:
          has('media_player.turn_on', 'media_player.turn_off', 'media_player.toggle', ...SAFE_HOMEASSISTANT_SERVICES) ||
          typeof (attrs as any).state === 'string' ||
          typeof (attrs as any).supported_features === 'number',
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: has(
          'media_player.media_play_pause',
          'media_player.media_play',
          'media_player.media_pause',
          'media_player.media_next_track',
          'media_player.media_previous_track'
        ),
        canVolume:
          has('media_player.volume_set', 'media_player.volume_up', 'media_player.volume_down') ||
          typeof (attrs as any).volume_level === 'number',
        canTemperature: false,
      };
    case 'climate':
      // `servicesForTarget` can be omitted for latency reasons. Infer support from attributes as well.
      const hasHvacAttrs =
        typeof (attrs as any).hvac_mode === 'string' ||
        (Array.isArray((attrs as any).hvac_modes) && (attrs as any).hvac_modes.length > 0);
      const hasSetpointAttrs =
        typeof (attrs as any).temperature === 'number' ||
        typeof (attrs as any).min_temp === 'number' ||
        typeof (attrs as any).max_temp === 'number' ||
        typeof (attrs as any).target_temp_step === 'number';

      return {
        canPower:
          has(
            ...SAFE_HOMEASSISTANT_SERVICES,
            'climate.turn_on',
            'climate.turn_off',
            'climate.set_hvac_mode'
          ) || hasHvacAttrs,
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: false,
        canVolume: false,
        canTemperature: has('climate.set_temperature') || hasSetpointAttrs,
      };
    default:
      return {
        canPower: has(...SAFE_HOMEASSISTANT_SERVICES),
        canBrightness: false,
        canColor: false,
        canColorTemperature: false,
        canPlayback: false,
        canVolume: false,
        canTemperature: false,
      };
  }
}

function getAlexaDeviceKind(device: UIDevice): string {
  if (isBlindDevice(device)) return 'blind';
  // Prefer Home Assistant domain-driven modeling when possible.
  // Labels can still override within a domain (e.g. boilers vs generic thermostats).
  if (device.domain === 'climate') {
    const raw = getPrimaryLabel(device).toLowerCase();
    if (raw === 'heating' || raw === 'boiler') return 'boiler';
    if (raw === 'radiators' || raw === 'radiator') return 'radiator';
    return 'thermostat';
  }
  if (device.domain === 'light') return 'light';
  if (device.domain === 'switch') return 'switch';
  if (device.domain === 'media_player') {
    const raw = getPrimaryLabel(device).toLowerCase();
    if (raw === 'tv') return 'tv';
    if (raw === 'speaker' || raw === 'spotify') return 'speaker';
    return 'speaker';
  }
  const raw = getPrimaryLabel(device).toLowerCase();
  if (raw === 'heating') return 'boiler';
  if (raw === 'radiators') return 'radiator';
  return raw;
}

function getMediaPowerCommandPrefix(device: UIDevice): 'tv' | 'speaker' {
  return getPrimaryLabel(device).toLowerCase() === 'tv' ? 'tv' : 'speaker';
}

function getPowerCommandForDevice(
  device: UIDevice,
  desiredOn: boolean
): { command: string; value?: number } | null {
  if (isBlindDevice(device)) {
    return { command: 'blind/set_position', value: desiredOn ? 100 : 0 };
  }

  if (device.domain === 'climate') {
    return { command: desiredOn ? 'boiler/turn_on' : 'boiler/turn_off' };
  }

  if (device.domain === 'light' || device.domain === 'switch') {
    return { command: desiredOn ? 'light/turn_on' : 'light/turn_off' };
  }

  if (device.domain === 'media_player') {
    const prefix = getMediaPowerCommandPrefix(device);
    return { command: desiredOn ? `${prefix}/turn_on` : `${prefix}/turn_off` };
  }

  if (desiredOn && hasService(device, 'homeassistant.turn_on')) {
    return { command: 'light/turn_on' };
  }
  if (!desiredOn && hasService(device, 'homeassistant.turn_off')) {
    return { command: 'light/turn_off' };
  }
  return null;
}

function normalizedDeviceState(device: UIDevice): string {
  return String(device.state || '').toLowerCase();
}

function isActiveState(state: string): boolean {
  return ['on', 'heat', 'open', 'playing', 'true', 'detected', 'armed'].includes(
    state.toLowerCase()
  );
}

function isDetectionActive(state: string): boolean {
  return ['on', 'open', 'detected', 'motion', 'pressed'].includes(
    state.toLowerCase()
  );
}

function getNumericAttribute(
  device: UIDevice,
  keys: string[],
  fallback?: number
): number | null {
  const attrs = device.attributes || {};

  for (const key of keys) {
    const raw = (attrs as Record<string, unknown>)[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  if (typeof fallback === 'number') {
    return fallback;
  }

  return null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getKelvinFromAttributes(attributes: Record<string, unknown>): number | null {
  const explicitKelvin =
    parseNumberLike((attributes as any).color_temp_kelvin) ??
    parseNumberLike((attributes as any).colorTemperatureInKelvin);
  if (explicitKelvin !== null) {
    return clamp(Math.round(explicitKelvin), 1000, 10000);
  }

  const mireds = parseNumberLike((attributes as any).color_temp);
  if (mireds !== null && mireds > 0) {
    return clamp(Math.round(1_000_000 / mireds), 1000, 10000);
  }

  return null;
}

function getAlexaColorFromAttributes(attributes: Record<string, unknown>): {
  hue: number;
  saturation: number;
  brightness: number;
} | null {
  const brightnessPctRaw =
    parseNumberLike((attributes as any).brightness_pct) ??
    (typeof (attributes as any).brightness === 'number'
      ? clamp(Math.round(((attributes as any).brightness as number) / 2.55), 0, 100)
      : null);
  const brightnessFromAttr =
    brightnessPctRaw !== null ? clamp(brightnessPctRaw / 100, 0, 1) : null;

  const hs = (attributes as any).hs_color;
  if (Array.isArray(hs) && hs.length >= 2) {
    const hue = parseNumberLike(hs[0]);
    const sat = parseNumberLike(hs[1]);
    if (hue !== null && sat !== null) {
      return {
        hue: clamp(hue, 0, 360),
        saturation: clamp(sat / 100, 0, 1),
        brightness: brightnessFromAttr ?? 1,
      };
    }
  }

  const rgb = (attributes as any).rgb_color;
  if (Array.isArray(rgb) && rgb.length >= 3) {
    const r = parseNumberLike(rgb[0]);
    const g = parseNumberLike(rgb[1]);
    const b = parseNumberLike(rgb[2]);
    if (r !== null && g !== null && b !== null) {
      const hsb = rgbToHsb(clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255));
      return { ...hsb, brightness: brightnessFromAttr ?? hsb.brightness };
    }
  }

  return null;
}

function rgbToHsb(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const saturation = max === 0 ? 0 : delta / max;
  return {
    hue: clamp(hue, 0, 360),
    saturation: clamp(saturation, 0, 1),
    brightness: max,
  };
}

function getNumericState(device: UIDevice): number | null {
  const fromState = Number(device.state);
  if (!Number.isNaN(fromState)) return fromState;

  return getNumericAttribute(device, ['temperature', 'current_temperature', 'currentTemperature']);
}

function getBoilerTargetSetpoint(device: UIDevice): number | null {
  return getNumericAttribute(device, [
    'temperature',
    'target_temperature',
    'target_temp',
    'targetTemperature',
  ]);
}

function getBlindPosition(device: UIDevice): number | null {
  // Home Assistant exposes blind position as 0-100 on current_position or position.
  return getNumericAttribute(device, ['current_position', 'position']);
}

function getAccessTokenFromDirective(directive: AlexaDirective): string {
  // Discovery: token lives under payload.scope.token
  if (directive.payload?.scope?.token) {
    return directive.payload.scope.token;
  }

  // Control: token lives under endpoint.scope.token
  if (directive.endpoint?.scope?.token) {
    return directive.endpoint.scope.token;
  }

  throw new Error('Missing access token in directive');
}

async function fetchDevices(
  accessToken: string,
  options?: { includeServicesForTarget?: boolean; timeoutMs?: number }
): Promise<UIDevice[]> {
  if (!DINODIA_API_BASE_URL) {
    throw new Error('DINODIA_API_BASE_URL is not set');
  }

  const includeServicesForTarget = options?.includeServicesForTarget === true;
  const timeoutMs = typeof options?.timeoutMs === 'number' ? options!.timeoutMs : null;
  const url =
    `${DINODIA_API_BASE_URL}/api/alexa/devices` +
    (includeServicesForTarget ? '?include_services_for_target=1' : '');

  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(() => controller!.abort(), timeoutMs) : null;

  const doFetch = async (requestUrl: string, signal?: AbortSignal) => {
    return await fetch(requestUrl, {
      method: 'GET',
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  };

  let res: Response;
  try {
    res = await doFetch(url, controller?.signal);
  } catch (err: any) {
    // If we attempted to include `servicesForTarget` but timed out or failed, fall back to
    // the fast endpoint to avoid breaking discovery/control latency budgets.
    if (includeServicesForTarget) {
      console.warn('fetchDevices: include_services_for_target failed; falling back', {
        error: err?.name || String(err),
      });
      res = await doFetch(`${DINODIA_API_BASE_URL}/api/alexa/devices`);
    } else {
      throw err;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AlexaAuthError('INVALID_AUTHORIZATION_CREDENTIAL');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('fetchDevices error', res.status, text);
    throw new Error(`Backend /api/alexa/devices error ${res.status}`);
  }

  const json = (await res.json()) as { devices: UIDevice[] };
  return json.devices || [];
}

class NativeAlexaUnavailableError extends Error {}

function isNativeAlexaEndpointId(endpointId: unknown): endpointId is string {
  return typeof endpointId === 'string' && /^dos_[A-Za-z0-9_-]{16,80}$/.test(endpointId);
}

async function fetchNativeDiscovery(accessToken: string): Promise<any> {
  if (!DINODIA_API_BASE_URL) throw new Error('DINODIA_API_BASE_URL is not set');
  const res = await fetch(`${DINODIA_API_BASE_URL}/api/alexa/v2/discovery`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401 || res.status === 403) throw new AlexaAuthError('INVALID_AUTHORIZATION_CREDENTIAL');
  if (res.status === 404 || res.status === 409 || res.status === 501) throw new NativeAlexaUnavailableError(`Native Alexa discovery unavailable (${res.status})`);
  if (!res.ok) throw new Error(`Backend native Alexa discovery error ${res.status}`);
  return await res.json();
}

async function forwardNativeDirective(directive: AlexaDirective, accessToken: string): Promise<any> {
  if (!DINODIA_API_BASE_URL) throw new Error('DINODIA_API_BASE_URL is not set');
  const path = directive.header.namespace === 'Alexa' && directive.header.name === 'ReportState' ? 'report-state' : 'directives';
  const res = await fetch(`${DINODIA_API_BASE_URL}/api/alexa/v2/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ directive }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new AlexaAuthError('INVALID_AUTHORIZATION_CREDENTIAL');
  if (!res.ok) {
    const error = new Error(typeof json?.error === 'string' ? json.error : 'Dinodia OS rejected the Alexa directive.') as Error & { alexaType?: string };
    error.alexaType = res.status === 404 ? 'NO_SUCH_ENDPOINT' : res.status >= 500 ? 'ENDPOINT_UNREACHABLE' : 'INVALID_DIRECTIVE';
    throw error;
  }
  return json;
}

async function sendDeviceCommand(
  accessToken: string,
  entityId: string,
  command: string,
  value?: number,
  payload?: Record<string, unknown>
): Promise<void> {
  if (!DINODIA_API_BASE_URL) {
    throw new Error('DINODIA_API_BASE_URL is not set');
  }

  const body: Record<string, unknown> = { entityId, command, source: 'alexa' };
  if (typeof value === 'number') body.value = value;
  if (payload && typeof payload === 'object') body.payload = payload;

  const res = await fetch(`${DINODIA_API_BASE_URL}/api/alexa/device-control`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AlexaAuthError('INVALID_AUTHORIZATION_CREDENTIAL');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('sendDeviceCommand error', res.status, text);
    throw new Error(`Backend /api/alexa/device-control error ${res.status}: ${text}`);
  }
}

async function repeatCommand(
  accessToken: string,
  entityId: string,
  command: string,
  times: number
): Promise<void> {
  const iterations = Math.max(0, Math.floor(times));
  for (let i = 0; i < iterations; i += 1) {
    await sendDeviceCommand(accessToken, entityId, command);
  }
}

class AlexaAuthError extends Error {
  public readonly alexaType: string;
  constructor(alexaType: string) {
    super(alexaType);
    this.alexaType = alexaType;
  }
}

// ---- Alexa response builders ----

function buildDiscoveryResponse(
  directive: AlexaDirective,
  endpoints: any[]
): any {
  return {
    event: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'Discover.Response',
        messageId: newMessageId(),
        payloadVersion: '3',
      },
      payload: {
        endpoints,
      },
    },
  };
}

function buildControlResponse(
  directive: AlexaDirective,
  endpointId: string,
  properties: any[]
): any {
  return {
    context: {
      properties,
    },
    event: {
      header: {
        namespace: 'Alexa',
        name: 'Response',
        messageId: newMessageId(),
        correlationToken: directive.header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: {
        endpointId,
      },
      payload: {},
    },
  };
}

function buildStateReportResponse(
  directive: AlexaDirective,
  endpointId: string,
  properties: any[]
): any {
  return {
    context: {
      properties,
    },
    event: {
      header: {
        namespace: 'Alexa',
        name: 'StateReport',
        messageId: newMessageId(),
        correlationToken: directive.header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: {
        endpointId,
      },
      payload: {},
    },
  };
}

function buildErrorResponse(
  directive: AlexaDirective,
  type: string,
  message: string,
  endpointId?: string
): any {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        messageId: newMessageId(),
        correlationToken: directive.header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: endpointId
        ? { endpointId }
        : undefined,
      payload: {
        type,
        message,
      },
    },
  };
}

function buildThermostatErrorResponse(
  directive: AlexaDirective,
  type: string,
  message: string,
  endpointId?: string
): any {
  return {
    event: {
      header: {
        namespace: 'Alexa.ThermostatController',
        name: 'ErrorResponse',
        messageId: newMessageId(),
        correlationToken: directive.header.correlationToken,
        payloadVersion: '3',
      },
      endpoint: endpointId ? { endpointId } : undefined,
      payload: {
        type,
        message,
      },
    },
  };
}

function getThermostatModeFromDevice(device: UIDevice): string {
  const hvacMode = String((device.attributes as any)?.hvac_mode ?? device.state ?? '')
    .toLowerCase()
    .trim();
  if (hvacMode === 'off') return 'OFF';
  if (hvacMode === 'cool') return 'COOL';
  if (hvacMode === 'auto' || hvacMode === 'heat_cool') return 'AUTO';
  if (hvacMode === 'eco') return 'ECO';
  if (hvacMode === 'em_heat') return 'EM_HEAT';
  return 'HEAT';
}

function temperatureObject(valueCelsius: number) {
  return { value: valueCelsius, scale: 'CELSIUS' };
}

// ---- Capability helpers ----

function alexaInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa',
    version: '3',
  };
}

function powerControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.PowerController',
    version: '3',
    properties: {
      supported: [{ name: 'powerState' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };
}

function brightnessControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.BrightnessController',
    version: '3',
    properties: {
      supported: [{ name: 'brightness' }],
      proactivelyReported: false,
      retrievable: true,
    },
  };
}

function colorControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ColorController',
    version: '3',
    properties: {
      supported: [{ name: 'color' }],
      proactivelyReported: false,
      retrievable: true,
    },
  };
}

function colorTemperatureControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ColorTemperatureController',
    version: '3',
    properties: {
      supported: [{ name: 'colorTemperatureInKelvin' }],
      proactivelyReported: false,
      retrievable: true,
    },
  };
}

function toggleControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ToggleController',
    instance: 'Blind.Toggle',
    version: '3',
    properties: {
      supported: [{ name: 'toggleState' }],
      proactivelyReported: false,
      retrievable: false,
    },
    capabilityResources: {
      friendlyNames: [
        {
          '@type': 'asset',
          value: { assetId: 'Alexa.Setting.Opening' },
        },
      ],
    },
  };
}

function rangeControllerInterface(
  instance: string,
  unitOfMeasure: string,
  minimumValue: number,
  maximumValue: number,
  precision: number,
  friendlyAssetId = 'Alexa.Setting.Opening'
) {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.RangeController',
    instance,
    version: '3',
    properties: {
      supported: [{ name: 'rangeValue' }],
      proactivelyReported: true,
      retrievable: true,
    },
    capabilityResources: {
      friendlyNames: [
        {
          '@type': 'asset',
          value: {
            assetId: friendlyAssetId,
          },
        },
      ],
    },
    configuration: {
      supportedRange: {
        minimumValue,
        maximumValue,
        precision,
      },
      unitOfMeasure,
    },
  };
}

function speakerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.Speaker',
    version: '3',
    properties: {
      supported: [
        { name: 'volume' },
        { name: 'muted' },
      ],
      proactivelyReported: false,
      retrievable: false,
    },
  };
}

function playbackControllerInterface(operations: string[]) {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.PlaybackController',
    version: '3',
    supportedOperations: operations,
  };
}

function motionSensorInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.MotionSensor',
    version: '3',
    properties: {
      supported: [{ name: 'detectionState' }],
      proactivelyReported: false,
      retrievable: true,
    },
  };
}

function contactSensorInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ContactSensor',
    version: '3',
    properties: {
      supported: [{ name: 'detectionState' }],
      proactivelyReported: false,
      retrievable: true,
    },
  };
}

function openCloseControllerInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.OpenCloseController',
    version: '3',
    properties: {
      supported: [{ name: 'openState' }],
      proactivelyReported: false,
      retrievable: true,
    },
    configuration: {
      supportsOpen: true,
      supportsClose: true,
      supportsStop: false,
    },
  };
}

function thermostatControllerInterface(supportedModes: string[] = ['HEAT', 'OFF']) {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.ThermostatController',
    version: '3.2',
    properties: {
      supported: [{ name: 'targetSetpoint' }, { name: 'thermostatMode' }],
      proactivelyReported: true,
      retrievable: true,
    },
    configuration: {
      supportedModes,
    },
  };
}

function getSupportedThermostatModesFromDevice(device: UIDevice): string[] {
  const attrs = (device.attributes ?? {}) as Record<string, unknown>;
  const hvacModes = Array.isArray((attrs as any).hvac_modes)
    ? (attrs as any).hvac_modes
        .filter((m: unknown): m is string => typeof m === 'string')
        .map((m: string) => m.toLowerCase())
    : [];

  const supported = new Set<string>();

  for (const mode of hvacModes) {
    if (mode === 'heat') supported.add('HEAT');
    else if (mode === 'cool') supported.add('COOL');
    else if (mode === 'auto') supported.add('AUTO');
    else if (mode === 'heat_cool') supported.add('AUTO');
    else if (mode === 'off') supported.add('OFF');
  }

  // Ensure OFF is always present for thermostats (matches Alexa UX expectations).
  supported.add('OFF');

  // Alexa requires at least one of HEAT or COOL in supportedModes.
  if (!supported.has('HEAT') && !supported.has('COOL')) {
    supported.add('HEAT');
  }

  return Array.from(supported);
}

function temperatureSensorInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.TemperatureSensor',
    version: '3',
    properties: {
      supported: [{ name: 'temperature' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };
}

function endpointHealthInterface() {
  return {
    type: 'AlexaInterface',
    interface: 'Alexa.EndpointHealth',
    version: '3.1',
    properties: {
      supported: [{ name: 'connectivity' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };
}

// Map your UIDevice → Alexa endpoint objects
function devicesToEndpoints(devices: UIDevice[]): any[] {
  const endpoints: any[] = [];
  const counts: Record<string, number> = {};

  const hasClimateWithSameObjectId = new Set<string>();
  for (const device of devices) {
    if (device.domain === 'climate' && typeof device.entityId === 'string') {
      hasClimateWithSameObjectId.add(device.entityId.split('.')[1] ?? '');
    }
  }

  for (const d of devices) {
    const label = getPrimaryLabel(d);
    const kind = getAlexaDeviceKind(d);
    const profile = inferEntityCapabilityProfile(d);

    const roomName = d.areaName || d.area || '';
    const realEntityId = kind === 'blind' ? getBlindEntityId(d) : d.entityId;
    const endpointId = encodeEndpointId(realEntityId);
    const friendlyName = sanitizeFriendlyName(d.name);

    const baseCapabilities: any[] = [alexaInterface()];
    const endpoint = {
      endpointId,
      manufacturerName: 'Dinodia',
      friendlyName,
      description: label || d.name,
      displayCategories: [] as string[],
      cookie: {
        entityId: realEntityId,
        domain: d.domain,
        areaName: roomName,
        label,
        deviceType: kind,
      },
      capabilities: baseCapabilities,
    };

    const playbackOperations = ['Play', 'Pause', 'PlayPause', 'Next', 'Previous'];
    let include = false;

    switch (kind) {
      case 'light': {
        endpoint.displayCategories = ['LIGHT'];
        if (profile.canPower) {
          endpoint.capabilities.push(powerControllerInterface());
        }
        if (profile.canBrightness) {
          endpoint.capabilities.push(brightnessControllerInterface());
        }
        if (profile.canColor) {
          endpoint.capabilities.push(colorControllerInterface());
        }
        if (profile.canColorTemperature) {
          endpoint.capabilities.push(colorTemperatureControllerInterface());
        }
        include = profile.canPower || profile.canBrightness;
        include = include || profile.canColor || profile.canColorTemperature;
        break;
      }
      case 'switch': {
        endpoint.displayCategories = ['SWITCH'];
        endpoint.capabilities.push(powerControllerInterface());
        include = true;
        break;
      }
      case 'blind': {
        // Expose blinds as INTERIOR_BLIND with a RangeController
        // for position (0-100), mapped to blind/open and blind/close
        // commands on the backend.
        endpoint.displayCategories = ['INTERIOR_BLIND'];
        endpoint.capabilities.push(powerControllerInterface());
        endpoint.capabilities.push(
          rangeControllerInterface(
            'Blind.Position',
            'Alexa.Unit.Percent',
            0,
            100,
            1,
            'Alexa.Setting.Opening'
          )
        );
        include = true;
        break;
      }
      case 'tv': {
        endpoint.displayCategories = ['TV'];
        if (profile.canPower) endpoint.capabilities.push(powerControllerInterface());
        if (profile.canVolume) endpoint.capabilities.push(speakerInterface());
        if (profile.canPlayback) {
          endpoint.capabilities.push(playbackControllerInterface(playbackOperations));
        }
        include = profile.canPower || profile.canVolume || profile.canPlayback;
        break;
      }
      case 'speaker': {
        endpoint.displayCategories = ['SPEAKER'];
        if (profile.canPower) endpoint.capabilities.push(powerControllerInterface());
        if (profile.canVolume) endpoint.capabilities.push(speakerInterface());
        if (profile.canPlayback) {
          endpoint.capabilities.push(playbackControllerInterface(playbackOperations));
        }
        include = profile.canPower || profile.canVolume || profile.canPlayback;
        break;
      }
      case 'spotify': {
        endpoint.displayCategories = ['SPEAKER'];
        if (profile.canVolume) endpoint.capabilities.push(speakerInterface());
        if (profile.canPlayback) {
          endpoint.capabilities.push(playbackControllerInterface(playbackOperations));
        }
        if (profile.canPower) endpoint.capabilities.push(powerControllerInterface());
        include = profile.canPower || profile.canVolume || profile.canPlayback;
        break;
      }
      case 'boiler':
      case 'radiator':
      case 'thermostat': {
        // Some setups can expose both `switch.<id>` and `climate.<id>` for the same
        // physical device. Thermostats should always be modeled using the climate
        // entity when available. If this is a non-climate entity and we have a
        // matching climate object id, skip this endpoint to avoid duplicates and
        // invalid capability modeling.
        if (d.domain !== 'climate') {
          const objectId = String(d.entityId ?? '').split('.')[1] ?? '';
          if (objectId && hasClimateWithSameObjectId.has(objectId)) {
            include = false;
            break;
          }
        }

        endpoint.displayCategories = ['THERMOSTAT', 'TEMPERATURE_SENSOR'];
        const supportedModes = getSupportedThermostatModesFromDevice(d);
        endpoint.capabilities.push(thermostatControllerInterface(supportedModes));
        endpoint.capabilities.push(temperatureSensorInterface());
        endpoint.capabilities.push(endpointHealthInterface());
        include = profile.canTemperature || profile.canPower || d.domain === 'climate';
        break;
      }
      case 'motion sensor': {
        endpoint.displayCategories = ['MOTION_SENSOR'];
        endpoint.capabilities.push(motionSensorInterface());
        include = true;
        break;
      }
      case 'doorbell': {
        endpoint.displayCategories = ['DOORBELL'];
        endpoint.capabilities.push(contactSensorInterface());
        include = true;
        break;
      }
      case 'home security': {
        endpoint.displayCategories = ['SECURITY_PANEL'];
        endpoint.capabilities.push(contactSensorInterface());
        include = true;
        break;
      }
      default:
        break;
    }

    if (include) {
      counts[kind] = (counts[kind] || 0) + 1;
      endpoints.push(endpoint);
    }
  }

  console.log(
    `devicesToEndpoints built ${endpoints.length} endpoints`,
    JSON.stringify(counts)
  );
  return endpoints;
}

function buildStateProperties(device: UIDevice, label: string): any[] {
  const sampleTime = nowIso();
  const normalizedState = normalizedDeviceState(device);
  const properties: any[] = [];
  const profile = inferEntityCapabilityProfile(device);

  switch (label) {
    case 'light':
    case 'switch':
    case 'tv':
    case 'speaker': {
      if (profile.canPower) {
        properties.push({
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: isActiveState(normalizedState) ? 'ON' : 'OFF',
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        });
      }
      if (profile.canBrightness) {
        const brightness =
          getNumericAttribute(device, ['brightness_pct']) ??
          (() => {
            const rawBrightness = getNumericAttribute(device, ['brightness']);
            return rawBrightness !== null ? Math.round((rawBrightness / 255) * 100) : null;
          })();
        if (brightness !== null) {
          properties.push({
            namespace: 'Alexa.BrightnessController',
            name: 'brightness',
            value: clamp(Math.round(brightness), 0, 100),
            timeOfSample: sampleTime,
            uncertaintyInMilliseconds: 500,
          });
        }
      }
      if (label === 'light') {
        const colorMode = String((device.attributes as any)?.color_mode ?? '').toLowerCase();
        const kelvin = getKelvinFromAttributes(device.attributes ?? {});
        const color = getAlexaColorFromAttributes(device.attributes ?? {});
        if (profile.canColorTemperature && kelvin !== null && colorMode.includes('color_temp')) {
          properties.push({
            namespace: 'Alexa.ColorTemperatureController',
            name: 'colorTemperatureInKelvin',
            value: kelvin,
            timeOfSample: sampleTime,
            uncertaintyInMilliseconds: 500,
          });
        } else if (profile.canColor && color) {
          properties.push({
            namespace: 'Alexa.ColorController',
            name: 'color',
            value: color,
            timeOfSample: sampleTime,
            uncertaintyInMilliseconds: 500,
          });
        } else if (profile.canColorTemperature && kelvin !== null) {
          properties.push({
            namespace: 'Alexa.ColorTemperatureController',
            name: 'colorTemperatureInKelvin',
            value: kelvin,
            timeOfSample: sampleTime,
            uncertaintyInMilliseconds: 500,
          });
        }
      }
      if (profile.canVolume) {
        const volume = getNumericAttribute(device, ['volume_level']);
        if (volume !== null) {
          properties.push({
            namespace: 'Alexa.Speaker',
            name: 'volume',
            value: clamp(Math.round(volume <= 1 ? volume * 100 : volume), 0, 100),
            timeOfSample: sampleTime,
            uncertaintyInMilliseconds: 500,
          });
        }
      }
      break;
    }
    case 'blind': {
      const position = getBlindPosition(device);
      const isOpen =
        position !== null ? position > 0 : isActiveState(normalizedState);

      const rangeValue =
        position !== null
          ? clamp(Math.round(position), 0, 100)
          : isOpen
            ? 100
            : 0;

      properties.push(
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: isOpen ? 'ON' : 'OFF',
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        },
        {
          namespace: 'Alexa.RangeController',
          instance: 'Blind.Position',
          name: 'rangeValue',
          value: rangeValue,
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        }
      );
      break;
    }
    case 'boiler':
    case 'radiator':
    case 'thermostat': {
      const attrs = device.attributes ?? {};
      const minTemp = getNumericAttribute(device, ['min_temp'], 10) ?? 10;
      const maxTemp = getNumericAttribute(device, ['max_temp'], 35) ?? 35;
      const step = getNumericAttribute(device, ['target_temp_step'], 1) ?? 1;

      const thermostatModeValue = getThermostatModeFromDevice(device);

      const targetTemp =
        getBoilerTargetSetpoint(device) ??
        getNumericAttribute(device, ['temperature', 'target_temperature', 'target_temp']);

      if (targetTemp !== null) {
        const safeStep = typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : 1;
        const quantized = Math.round(targetTemp / safeStep) * safeStep;
        properties.push({
          namespace: 'Alexa.ThermostatController',
          name: 'targetSetpoint',
          value: { value: clamp(quantized, minTemp, maxTemp), scale: 'CELSIUS' },
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        });
      }

      properties.push({
        namespace: 'Alexa.ThermostatController',
        name: 'thermostatMode',
        value: thermostatModeValue,
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      });

      const currentTemp = getNumericAttribute(device, ['current_temperature', 'currentTemperature']);
      if (currentTemp !== null) {
        properties.push({
          namespace: 'Alexa.TemperatureSensor',
          name: 'temperature',
          value: { value: clamp(currentTemp, -50, 100), scale: 'CELSIUS' },
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        });
      }

      properties.push({
        namespace: 'Alexa.EndpointHealth',
        name: 'connectivity',
        value: { value: 'OK' },
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      });
      break;
    }
    case 'motion sensor': {
      properties.push({
        namespace: 'Alexa.MotionSensor',
        name: 'detectionState',
        value: isDetectionActive(normalizedState) ? 'DETECTED' : 'NOT_DETECTED',
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      });
      break;
    }
    case 'doorbell':
    case 'home security': {
      properties.push({
        namespace: 'Alexa.ContactSensor',
        name: 'detectionState',
        value: isDetectionActive(normalizedState) ? 'DETECTED' : 'NOT_DETECTED',
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      });
      break;
    }
    default:
      break;
  }

  return properties;
}

// ---- Directive handlers ----

async function handleDiscovery(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  try {
    return await fetchNativeDiscovery(accessToken);
  } catch (error) {
    if (!(error instanceof NativeAlexaUnavailableError)) throw error;
  }

  // Try to include `servicesForTarget` for richer capability inference, but keep a tight timeout
  // and fall back to the fast variant if needed to avoid Alexa timeouts.
  const devices = await fetchDevices(accessToken, { includeServicesForTarget: true, timeoutMs: 1200 });
  const endpoints = devicesToEndpoints(devices);
  console.log(
    'Discovery endpointId preview',
    JSON.stringify(endpoints.slice(0, 3).map((e) => e?.endpointId))
  );
  if (endpoints[0]) {
    const sample = JSON.stringify(endpoints[0]);
    console.log('Discovery endpoint sample (first)', sample.slice(0, 3500));
  }

  return buildDiscoveryResponse(directive, endpoints);
}

async function handlePowerController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Missing endpointId'
    );
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const actionName = directive.header.name; // 'TurnOn' | 'TurnOff'
  const desiredOn = actionName === 'TurnOn';
  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));

  if (!device) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Device not found',
      endpointId
    );
  }

  const powerCommand = getPowerCommandForDevice(device, desiredOn);
  if (!powerCommand) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device for PowerController',
      endpointId
    );
  }

  const targetEntityId = isBlindDevice(device) ? getBlindEntityId(device) : haEntityId;
  if (typeof powerCommand.value === 'number') {
    await sendDeviceCommand(accessToken, targetEntityId, powerCommand.command, powerCommand.value);
  } else {
    await sendDeviceCommand(accessToken, targetEntityId, powerCommand.command);
  }

  const properties = [
    {
      namespace: 'Alexa.PowerController',
      name: 'powerState',
      value: desiredOn ? 'ON' : 'OFF',
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    },
  ];

  return buildControlResponse(directive, endpointId, properties);
}

async function handleToggleController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Missing endpointId'
    );
  }

  const instance = directive.header.instance;
  if (!instance) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Missing ToggleController instance',
      endpointId
    );
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));

  if (!device) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Device not found',
      endpointId
    );
  }

  const normalizedLabel = isBlindDevice(device)
    ? 'blind'
    : getPrimaryLabel(device).toLowerCase();
  if (normalizedLabel !== 'blind' || instance !== 'Blind.Toggle') {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device type or instance for ToggleController',
      endpointId
    );
  }

  const name = directive.header.name; // 'TurnOn' | 'TurnOff'
  let command: string | null = null;
  let targetState: 'ON' | 'OFF' = 'OFF';

  if (name === 'TurnOn') {
    command = 'blind/open';
    targetState = 'ON';
  } else if (name === 'TurnOff') {
    command = 'blind/close';
    targetState = 'OFF';
  } else {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      `Unsupported ToggleController directive ${name}`,
      endpointId
    );
  }

  await sendDeviceCommand(accessToken, getBlindEntityId(device), command);

  const properties = [
    {
      namespace: 'Alexa.ToggleController',
      instance: 'Blind.Toggle',
      name: 'toggleState',
      value: targetState,
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    },
  ];

  return buildControlResponse(directive, endpointId, properties);
}


async function handleBrightnessController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Missing endpointId'
    );
  }

  const brightness = directive.payload?.brightness;
  if (typeof brightness !== 'number') {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Missing brightness value',
      endpointId
    );
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));

  if (!device) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Device not found',
      endpointId
    );
  }

  const profile = inferEntityCapabilityProfile(device);
  if (!profile.canBrightness) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device for BrightnessController',
      endpointId
    );
  }

  const value = clamp(Math.round(brightness), 0, 100);

  await sendDeviceCommand(accessToken, haEntityId, 'light/set_brightness', value);

  const properties = [
    {
      namespace: 'Alexa.BrightnessController',
      name: 'brightness',
      value,
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    },
  ];

  return buildControlResponse(directive, endpointId, properties);
}

async function handleColorController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Missing endpointId');
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const color = directive.payload?.color;
  if (!color || typeof color !== 'object') {
    return buildErrorResponse(directive, 'INVALID_DIRECTIVE', 'Missing color payload', endpointId);
  }

  const hue = parseNumberLike((color as any).hue);
  const saturation = parseNumberLike((color as any).saturation);
  const brightness = parseNumberLike((color as any).brightness);
  if (hue === null || saturation === null) {
    return buildErrorResponse(directive, 'INVALID_DIRECTIVE', 'Invalid color payload', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));
  if (!device) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Device not found', endpointId);
  }

  const profile = inferEntityCapabilityProfile(device);
  if (!profile.canColor) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device for ColorController',
      endpointId
    );
  }

  const safeHue = clamp(hue, 0, 360);
  const safeSaturation = clamp(saturation, 0, 1);
  const safeBrightness = typeof brightness === 'number' ? clamp(brightness, 0, 1) : null;

  const normalized: Record<string, unknown> = {
    hue: safeHue,
    saturation: safeSaturation,
    ...(safeBrightness !== null ? { brightness: safeBrightness } : {}),
  };

  await sendDeviceCommand(accessToken, haEntityId, 'light/set_color', undefined, normalized);

  const properties = [
    {
      namespace: 'Alexa.ColorController',
      name: 'color',
      value: {
        hue: safeHue,
        saturation: safeSaturation,
        brightness: safeBrightness ?? 1,
      },
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    },
  ];

  return buildControlResponse(directive, endpointId, properties);
}

async function handleColorTemperatureController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Missing endpointId');
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));
  if (!device) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Device not found', endpointId);
  }

  const profile = inferEntityCapabilityProfile(device);
  if (!profile.canColorTemperature) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device for ColorTemperatureController',
      endpointId
    );
  }

  const name = directive.header.name;
  const payload = directive.payload || {};

  const currentKelvin =
    getKelvinFromAttributes(device.attributes ?? {}) ??
    3500;

  let targetKelvin: number | null = null;

  if (name === 'SetColorTemperature') {
    const requested = parseNumberLike(payload.colorTemperatureInKelvin);
    if (requested === null) {
      return buildErrorResponse(
        directive,
        'INVALID_DIRECTIVE',
        'Missing colorTemperatureInKelvin',
        endpointId
      );
    }
    targetKelvin = requested;
  } else if (name === 'IncreaseColorTemperature') {
    targetKelvin = currentKelvin + 250;
  } else if (name === 'DecreaseColorTemperature') {
    targetKelvin = currentKelvin - 250;
  } else {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      `Unsupported ColorTemperatureController directive ${name}`,
      endpointId
    );
  }

  const safeKelvin = clamp(Math.round(targetKelvin), 1000, 10000);
  await sendDeviceCommand(
    accessToken,
    haEntityId,
    'light/set_color_temperature',
    undefined,
    { kelvin: safeKelvin }
  );

  const properties = [
    {
      namespace: 'Alexa.ColorTemperatureController',
      name: 'colorTemperatureInKelvin',
      value: safeKelvin,
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    },
  ];

  return buildControlResponse(directive, endpointId, properties);
}

async function handleSpeakerController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Missing endpointId'
    );
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));

  if (!device) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Device not found',
      endpointId
    );
  }

  const profile = inferEntityCapabilityProfile(device);
  if (!profile.canVolume) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device type for SpeakerController',
      endpointId
    );
  }

  const name = directive.header.name;
  const payload = directive.payload || {};
  const sampleTime = nowIso();
  const properties: any[] = [];

  if (name === 'SetVolume') {
    const volume = payload.volume;
    if (typeof volume !== 'number') {
      return buildErrorResponse(
        directive,
        'INVALID_DIRECTIVE',
        'Missing volume value',
        endpointId
      );
    }
    const targetVolume = clamp(Math.round(volume), 0, 100);
    await sendDeviceCommand(accessToken, haEntityId, 'media/volume_set', targetVolume);
    properties.push(
      {
        namespace: 'Alexa.Speaker',
        name: 'volume',
        value: targetVolume,
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      },
      {
        namespace: 'Alexa.Speaker',
        name: 'muted',
        value: targetVolume === 0,
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      }
    );
  } else if (name === 'AdjustVolume') {
    let steps = 0;
    if (typeof payload.volumeSteps === 'number' && payload.volumeSteps !== 0) {
      steps = payload.volumeSteps;
    } else if (payload.volumeDefault) {
      steps = 1;
    }

    if (steps === 0) {
      return buildErrorResponse(
        directive,
        'INVALID_DIRECTIVE',
        'Missing volumeSteps',
        endpointId
      );
    }

    const command = steps > 0 ? 'media/volume_up' : 'media/volume_down';
    await repeatCommand(accessToken, haEntityId, command, Math.abs(steps));

    const reportedVolume =
      getNumericAttribute(device, ['volume']) ??
      (steps > 0 ? 60 : 40);

    properties.push({
      namespace: 'Alexa.Speaker',
      name: 'volume',
      value: clamp(Math.round(reportedVolume + steps * 5), 0, 100),
      timeOfSample: sampleTime,
      uncertaintyInMilliseconds: 500,
    });
  } else if (name === 'SetMute') {
    const mute = Boolean(payload.mute);
    const targetVolume = mute ? 0 : 40;
    await sendDeviceCommand(accessToken, haEntityId, 'media/volume_set', targetVolume);
    properties.push(
      {
        namespace: 'Alexa.Speaker',
        name: 'muted',
        value: mute,
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      },
      {
        namespace: 'Alexa.Speaker',
        name: 'volume',
        value: targetVolume,
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      }
    );
  } else {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      `Unsupported speaker directive ${name}`,
      endpointId
    );
  }

  return buildControlResponse(directive, endpointId, properties);
}

async function handlePlaybackController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Missing endpointId'
    );
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));

  if (!device) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Device not found',
      endpointId
    );
  }

  const profile = inferEntityCapabilityProfile(device);
  if (!profile.canPlayback) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device type for PlaybackController',
      endpointId
    );
  }

  const name = directive.header.name;
  let command: string | null = null;

  switch (name) {
    case 'Play':
    case 'Pause':
    case 'PlayPause':
      command = 'media/play_pause';
      break;
    case 'Next':
      command = 'media/next';
      break;
    case 'Previous':
      command = 'media/previous';
      break;
    default:
      break;
  }

  if (!command) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      `Unsupported playback directive ${name}`,
      endpointId
    );
  }

  await sendDeviceCommand(accessToken, haEntityId, command);

  return buildControlResponse(directive, endpointId, []);
}

async function handleOpenCloseController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Missing endpointId'
    );
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));

  if (!device) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Device not found',
      endpointId
    );
  }

  const label = isBlindDevice(device)
    ? 'blind'
    : getPrimaryLabel(device).toLowerCase();
  if (label !== 'blind') {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device type for OpenCloseController',
      endpointId
    );
  }

  const name = directive.header.name; // 'Open' | 'Close'
  let command: string | null = null;
  let targetState: 'OPEN' | 'CLOSED' = 'CLOSED';

  if (name === 'Open') {
    command = 'blind/open';
    targetState = 'OPEN';
  } else if (name === 'Close') {
    command = 'blind/close';
    targetState = 'CLOSED';
  } else {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      `Unsupported OpenClose directive ${name}`,
      endpointId
    );
  }

  await sendDeviceCommand(accessToken, getBlindEntityId(device), command);

  const properties = [
    {
      namespace: 'Alexa.OpenCloseController',
      name: 'openState',
      value: {
        value: targetState,
      },
      timeOfSample: nowIso(),
      uncertaintyInMilliseconds: 500,
    },
  ];

  return buildControlResponse(directive, endpointId, properties);
}

async function handleRangeController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Missing endpointId'
    );
  }

  const instance = directive.header.instance;
  if (!instance) {
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Missing RangeController instance',
      endpointId
    );
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));

  if (!device) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Device not found',
      endpointId
    );
  }

  const label = getAlexaDeviceKind(device);
  const name = directive.header.name;
  const payload = directive.payload || {};
  const sampleTime = nowIso();

  if (label === 'blind' && instance === 'Blind.Position') {
    const currentPos = getBlindPosition(device);
    const normalizedState = normalizedDeviceState(device);
    const effectiveCurrent =
      currentPos !== null
        ? clamp(Math.round(currentPos), 0, 100)
        : isActiveState(normalizedState)
          ? 100
          : 0;

    if (name === 'SetRangeValue') {
      const target = payload.rangeValue;
      if (typeof target !== 'number') {
        return buildErrorResponse(
          directive,
          'INVALID_DIRECTIVE',
          'Missing rangeValue',
          endpointId
        );
      }

      const normalizedTarget = clamp(Math.round(target), 0, 100);

      await sendDeviceCommand(
        accessToken,
        getBlindEntityId(device),
        'blind/set_position',
        normalizedTarget
      );

      const properties = [
        {
          namespace: 'Alexa.RangeController',
          instance: 'Blind.Position',
          name: 'rangeValue',
          value: normalizedTarget,
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        },
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: normalizedTarget > 0 ? 'ON' : 'OFF',
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        },
      ];

      return buildControlResponse(directive, endpointId, properties);
    }

    if (name === 'AdjustRangeValue') {
      let delta = 0;
      if (
        typeof payload.rangeValueDelta === 'number' &&
        payload.rangeValueDelta !== 0
      ) {
        delta = payload.rangeValueDelta;
      } else if (payload.rangeValueDeltaDefault) {
        delta = 10;
      }

      if (delta === 0) {
        return buildErrorResponse(
          directive,
          'INVALID_DIRECTIVE',
          'Missing rangeValueDelta',
          endpointId
        );
      }

      const newTarget = clamp(effectiveCurrent + Math.round(delta), 0, 100);

      await sendDeviceCommand(
        accessToken,
        getBlindEntityId(device),
        'blind/set_position',
        newTarget
      );

      const properties = [
        {
          namespace: 'Alexa.RangeController',
          instance: 'Blind.Position',
          name: 'rangeValue',
          value: newTarget,
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        },
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: newTarget > 0 ? 'ON' : 'OFF',
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        },
      ];

      return buildControlResponse(directive, endpointId, properties);
    }

    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      `Unsupported RangeController directive ${name}`,
      endpointId
    );
  }

  if ((label === 'boiler' || label === 'radiator') && instance === 'Boiler.Temperature') {
    const minTemp = getNumericAttribute(device, ['min_temp'], 10) ?? 10;
    const maxTemp = getNumericAttribute(device, ['max_temp'], 35) ?? 35;
    const step = getNumericAttribute(device, ['target_temp_step'], 1) ?? 1;
    const isOff =
      normalizedDeviceState(device) === 'off' ||
      (typeof (device.attributes as any)?.hvac_mode === 'string' &&
        String((device.attributes as any).hvac_mode).toLowerCase() === 'off');
    const quantize = (value: number) => {
      const safeStep = typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : 1;
      return Math.round(value / safeStep) * safeStep;
    };
    if (name === 'SetRangeValue') {
      const target = payload.rangeValue;
      if (typeof target !== 'number') {
        return buildErrorResponse(
          directive,
          'INVALID_DIRECTIVE',
          'Missing rangeValue',
          endpointId
        );
      }
      const normalizedTarget = clamp(quantize(target), minTemp, maxTemp);
      if (isOff) {
        await sendDeviceCommand(accessToken, haEntityId, 'boiler/turn_on');
      }
      await sendDeviceCommand(accessToken, haEntityId, 'boiler/set_temperature', normalizedTarget);

      const properties = [
        {
          namespace: 'Alexa.RangeController',
          instance: 'Boiler.Temperature',
          name: 'rangeValue',
          value: normalizedTarget,
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        },
      ];

      return buildControlResponse(directive, endpointId, properties);
    }

    if (name === 'AdjustRangeValue') {
      let delta = 0;
      if (typeof payload.rangeValueDelta === 'number' && payload.rangeValueDelta !== 0) {
        delta = payload.rangeValueDelta;
      } else if (payload.rangeValueDeltaDefault) {
        delta = 1;
      }

      if (delta === 0) {
        return buildErrorResponse(
          directive,
          'INVALID_DIRECTIVE',
          'Missing rangeValueDelta',
          endpointId
        );
      }

      const base =
        getBoilerTargetSetpoint(device) ??
        getNumericState(device) ??
        (minTemp + maxTemp) / 2;
      const newTarget = clamp(quantize(base + delta), minTemp, maxTemp);

      if (isOff) {
        await sendDeviceCommand(accessToken, haEntityId, 'boiler/turn_on');
      }
      await sendDeviceCommand(accessToken, haEntityId, 'boiler/set_temperature', newTarget);

      const properties = [
        {
          namespace: 'Alexa.RangeController',
          instance: 'Boiler.Temperature',
          name: 'rangeValue',
          value: newTarget,
          timeOfSample: sampleTime,
          uncertaintyInMilliseconds: 500,
        },
      ];

      return buildControlResponse(directive, endpointId, properties);
    }

    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      `Unsupported RangeController directive ${name}`,
      endpointId
    );
  }

  return buildErrorResponse(
    directive,
    'INVALID_DIRECTIVE',
    'Unsupported RangeController instance',
    endpointId
  );
}

async function handleThermostatController(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildThermostatErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Missing endpointId');
  }

  const haEntityId = getHaEntityIdFromDirective(directive);
  if (!haEntityId) {
    return buildThermostatErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Invalid endpointId', endpointId);
  }

  const devices = await fetchDevices(accessToken);
  const device = devices.find((d) => deviceMatchesHaEntityId(d, haEntityId));
  if (!device) {
    return buildThermostatErrorResponse(directive, 'NO_SUCH_ENDPOINT', 'Device not found', endpointId);
  }

  if (device.domain !== 'climate') {
    return buildThermostatErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      'Unsupported device type for ThermostatController',
      endpointId
    );
  }

  const profile = inferEntityCapabilityProfile(device);
  const name = directive.header.name;
  const payload = directive.payload || {};

  const minTemp = getNumericAttribute(device, ['min_temp'], 10) ?? 10;
  const maxTemp = getNumericAttribute(device, ['max_temp'], 35) ?? 35;
  const step = getNumericAttribute(device, ['target_temp_step'], 1) ?? 1;
  const safeStep = typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : 1;
  const sampleTime = nowIso();

  const toCelsius = (value: number, scaleRaw: unknown): number => {
    const scale = String(scaleRaw ?? 'CELSIUS').toUpperCase();
    if (scale === 'FAHRENHEIT') {
      return (value - 32) * (5 / 9);
    }
    return value;
  };

  const toCelsiusDelta = (value: number, scaleRaw: unknown): number => {
    const scale = String(scaleRaw ?? 'CELSIUS').toUpperCase();
    if (scale === 'FAHRENHEIT') {
      return value * (5 / 9);
    }
    return value;
  };

  if (name === 'SetTargetTemperature') {
    if (!profile.canTemperature) {
      return buildThermostatErrorResponse(
        directive,
        'INVALID_DIRECTIVE',
        'Thermostat does not support setting target temperature',
        endpointId
      );
    }

    const rawValue = parseNumberLike(payload?.targetSetpoint?.value);
    if (rawValue === null) {
      return buildThermostatErrorResponse(directive, 'INVALID_VALUE', 'Missing targetSetpoint', endpointId);
    }

    const celsius = toCelsius(rawValue, payload?.targetSetpoint?.scale);
    const quantized = Math.round(celsius / safeStep) * safeStep;
    const clamped = clamp(quantized, minTemp, maxTemp);

    let responseMode = getThermostatModeFromDevice(device);
    // Ensure a non-OFF thermostat mode when a user sets a temperature.
    if (responseMode === 'OFF') {
      const supportedModes = new Set(getSupportedThermostatModesFromDevice(device));
      const preferredMode = supportedModes.has('HEAT')
        ? 'heat'
        : supportedModes.has('COOL')
          ? 'cool'
          : supportedModes.has('AUTO')
            ? 'auto'
            : 'heat';
      await sendDeviceCommand(accessToken, haEntityId, 'boiler/set_hvac_mode', undefined, {
        hvac_mode: preferredMode,
      });
      responseMode =
        preferredMode === 'cool' ? 'COOL' : preferredMode === 'auto' ? 'AUTO' : 'HEAT';
    }
    await sendDeviceCommand(accessToken, haEntityId, 'boiler/set_temperature', clamped);

    return buildControlResponse(directive, endpointId, [
      {
        namespace: 'Alexa.ThermostatController',
        name: 'thermostatMode',
        value: responseMode,
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      },
      {
        namespace: 'Alexa.ThermostatController',
        name: 'targetSetpoint',
        value: temperatureObject(clamped),
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      },
    ]);
  }

  if (name === 'AdjustTargetTemperature') {
    if (!profile.canTemperature) {
      return buildThermostatErrorResponse(
        directive,
        'INVALID_DIRECTIVE',
        'Thermostat does not support adjusting target temperature',
        endpointId
      );
    }

    const rawDelta = parseNumberLike(payload?.targetSetpointDelta?.value);
    if (rawDelta === null) {
      return buildThermostatErrorResponse(directive, 'INVALID_VALUE', 'Missing targetSetpointDelta', endpointId);
    }

    const deltaC = toCelsiusDelta(rawDelta, payload?.targetSetpointDelta?.scale);
    const currentTarget =
      getBoilerTargetSetpoint(device) ??
      getNumericAttribute(device, ['temperature', 'target_temperature', 'target_temp']);
    const currentTemperature =
      getNumericAttribute(device, ['current_temperature', 'currentTemperature']) ?? 20;
    const base = currentTarget ?? currentTemperature;
    const next = base + deltaC;
    const quantized = Math.round(next / safeStep) * safeStep;
    const clamped = clamp(quantized, minTemp, maxTemp);

    let responseMode = getThermostatModeFromDevice(device);
    if (responseMode === 'OFF') {
      const supportedModes = new Set(getSupportedThermostatModesFromDevice(device));
      const preferredMode = supportedModes.has('HEAT')
        ? 'heat'
        : supportedModes.has('COOL')
          ? 'cool'
          : supportedModes.has('AUTO')
            ? 'auto'
            : 'heat';
      await sendDeviceCommand(accessToken, haEntityId, 'boiler/set_hvac_mode', undefined, {
        hvac_mode: preferredMode,
      });
      responseMode =
        preferredMode === 'cool' ? 'COOL' : preferredMode === 'auto' ? 'AUTO' : 'HEAT';
    }
    await sendDeviceCommand(accessToken, haEntityId, 'boiler/set_temperature', clamped);

    return buildControlResponse(directive, endpointId, [
      {
        namespace: 'Alexa.ThermostatController',
        name: 'thermostatMode',
        value: responseMode,
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      },
      {
        namespace: 'Alexa.ThermostatController',
        name: 'targetSetpoint',
        value: temperatureObject(clamped),
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      },
    ]);
  }

  if (name === 'SetThermostatMode') {
    const modeRaw = String(payload?.thermostatMode?.value ?? '').toUpperCase();
    const supportedModes = new Set(getSupportedThermostatModesFromDevice(device));
    if (!supportedModes.has(modeRaw)) {
      return buildThermostatErrorResponse(directive, 'INVALID_VALUE', `Unsupported mode ${modeRaw}`, endpointId);
    }

    if (modeRaw === 'OFF') {
      await sendDeviceCommand(accessToken, haEntityId, 'boiler/turn_off');
    } else {
      const haMode =
        modeRaw === 'HEAT'
          ? 'heat'
          : modeRaw === 'COOL'
            ? 'cool'
            : modeRaw === 'AUTO'
              ? 'auto'
              : modeRaw === 'EM_HEAT'
                ? 'heat'
                : modeRaw.toLowerCase();
      await sendDeviceCommand(accessToken, haEntityId, 'boiler/set_hvac_mode', undefined, {
        hvac_mode: haMode,
      });
    }

    return buildControlResponse(directive, endpointId, [
      {
        namespace: 'Alexa.ThermostatController',
        name: 'thermostatMode',
        value: modeRaw,
        timeOfSample: sampleTime,
        uncertaintyInMilliseconds: 500,
      },
    ]);
  }

  return buildThermostatErrorResponse(
    directive,
    'INVALID_DIRECTIVE',
    `Unsupported ThermostatController directive ${name}`,
    endpointId
  );
}

async function handleReportState(event: AlexaEvent): Promise<any> {
  const directive = event.directive;
  const accessToken = getAccessTokenFromDirective(directive);

  const endpointId = directive.endpoint?.endpointId;
  if (!endpointId) {
    return buildErrorResponse(
      directive,
      'NO_SUCH_ENDPOINT',
      'Missing endpointId'
    );
  }

  if (isNativeAlexaEndpointId(endpointId)) {
    return forwardNativeDirective(directive, accessToken);
  }

  const haEntityId = getHaEntityIdFromDirective(directive);

  let device: UIDevice | null = null;
  let label: string | null = null;

  try {
    const devices = await fetchDevices(accessToken);
    device =
      haEntityId ? devices.find((d) => deviceMatchesHaEntityId(d, haEntityId)) ?? null : null;
    if (device) {
      label = getAlexaDeviceKind(device);
    }
  } catch (err) {
    console.error('handleReportState fetchDevices error', err);
  }

  // Fallback: build a minimal device from cookie if backend lookup fails
  if (!device) {
    const cookie: any = (directive.endpoint as any)?.cookie || {};
    const rawLabel = (cookie.label ?? '') as string;
    const cookieDeviceType = (cookie.deviceType ?? '') as string;
    label = (cookieDeviceType || rawLabel).toLowerCase() || null;

    device = {
      entityId: haEntityId ?? endpointId,
      name: cookie.entityId || endpointId,
      state: 'unknown',
      area: cookie.areaName ?? null,
      areaName: cookie.areaName ?? null,
      label: rawLabel || cookieDeviceType || null,
      labelCategory: null,
      labels: rawLabel || cookieDeviceType ? [rawLabel || cookieDeviceType] : [],
      domain: cookie.domain || 'light',
      attributes: {},
    };
  }

  const effectiveLabel = label || getAlexaDeviceKind(device);
  const properties = buildStateProperties(device, effectiveLabel);

  return buildStateReportResponse(directive, endpointId, properties);
}

async function handleAcceptGrant(directive: AlexaDirective): Promise<any> {
  console.log('Received Alexa.Authorization.AcceptGrant', {
    messageId: directive.header.messageId,
  });

  const grantCode = directive.payload?.grant?.code;
  const granteeTokenRaw = directive.payload?.grantee?.token;
  const backendBase = DINODIA_BACKEND_BASE_URL;
  const internalSecret = ALEXA_EVENTS_INTERNAL_SECRET;
  const granteeToken =
    typeof granteeTokenRaw === 'string' && granteeTokenRaw.trim()
      ? granteeTokenRaw.trim()
      : '';

  if (!grantCode) {
    console.error('AcceptGrant: missing grant.code in directive payload');
  }

  if (!backendBase || !internalSecret || !granteeToken) {
    console.error('AcceptGrant: missing required env vars', {
      hasBackendBase: !!backendBase,
      hasInternalSecret: !!internalSecret,
      hasGranteeToken: !!granteeToken,
    });
  } else if (grantCode) {
    console.log('Calling backend /api/alexa/events/accept-grant', {
      hasGrantCode: !!grantCode,
      hasGranteeToken: !!granteeToken,
    });
    try {
      const res = await fetch(`${backendBase}/api/alexa/events/accept-grant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': internalSecret,
          Authorization: `Bearer ${granteeToken}`,
        },
        body: JSON.stringify({
          code: grantCode,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('AcceptGrant -> backend error', res.status, text);
      } else {
        console.log('AcceptGrant -> backend success');
      }
    } catch (err) {
      console.error('AcceptGrant -> backend request failed', err);
    }
  }

  const header = directive.header;
  return {
    event: {
      header: {
        namespace: 'Alexa.Authorization',
        name: 'AcceptGrant.Response',
        messageId: header.messageId,
        payloadVersion: '3',
      },
      payload: {},
    },
  };
}

async function handleAuthorization(event: AlexaEvent): Promise<any> {
  const directive = event.directive;

  if (directive.header.name === 'AcceptGrant') {
    return handleAcceptGrant(directive);
  }

  return buildErrorResponse(
    directive,
    'INVALID_DIRECTIVE',
    `Unsupported authorization directive ${directive.header.name}`
  );
}

// ---- SQS worker handler ----

async function handleSqsEvent(event: any): Promise<void> {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  for (const record of records) {
    if (record.eventSource !== 'aws:sqs') continue;
    try {
      const payload = JSON.parse(record.body);
      const {
        scheduledAtEpochMs,
        haConnectionId,
        entityId,
        label,
        causeType,
        previousProperties,
      } = payload;

      const remainingMs = Math.max(0, Math.floor((scheduledAtEpochMs ?? 0) - Date.now()));
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }

      const internalSecret = process.env.ALEXA_CHANGE_REPORT_INTERNAL_SECRET;
      if (!DINODIA_API_BASE_URL || !internalSecret) {
        console.error('Missing env for internal change report', {
          DINODIA_API_BASE_URL,
          hasSecret: !!internalSecret,
        });
        continue;
      }

      const res = await fetch(`${DINODIA_API_BASE_URL}/api/internal/alexa/change-report`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          haConnectionId,
          entityId,
          label,
          causeType,
          previousProperties,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('ChangeReport worker failed', res.status, text.slice(0, 200));
      }
    } catch (err) {
      console.error('handleSqsEvent error', err);
    }
  }
}

// ---- Main Lambda handler ----

export const handler = async (event: any): Promise<any> => {
  // SQS worker path
  if (Array.isArray(event?.Records) && event.Records[0]?.eventSource === 'aws:sqs') {
    await handleSqsEvent(event);
    return;
  }

  // ASK Skill Events path (for auto-unlink, etc.)
  const requestType = event?.request?.type;
  if (typeof requestType === 'string' && requestType.startsWith('AlexaSkillEvent.')) {
    await handleAskSkillEvent(event);
    return {};
  }

  const directive = (event as AlexaEvent).directive;
  const { namespace, name, messageId, correlationToken, instance } = directive.header;
  const endpointId = directive.endpoint?.endpointId;

  console.log(
    'Incoming Alexa directive',
    JSON.stringify({
      namespace,
      name,
      messageId,
      correlationToken,
      instance,
      endpointId,
    })
  );

  try {
    if (namespace === 'Alexa.Authorization' && name === 'AcceptGrant') {
      return await handleAuthorization(event);
    }

    if (namespace === 'Alexa.Discovery' && name === 'Discover') {
      return await handleDiscovery(event);
    }

    if (isNativeAlexaEndpointId(endpointId)) {
      const accessToken = getAccessTokenFromDirective(directive);
      return await forwardNativeDirective(directive, accessToken);
    }

    if (namespace === 'Alexa.PowerController') {
      return await handlePowerController(event);
    }

    if (namespace === 'Alexa.ToggleController') {
      return await handleToggleController(event);
    }

    if (namespace === 'Alexa.BrightnessController') {
      return await handleBrightnessController(event);
    }

    if (namespace === 'Alexa.ColorController') {
      return await handleColorController(event);
    }

    if (namespace === 'Alexa.ColorTemperatureController') {
      return await handleColorTemperatureController(event);
    }

    if (namespace === 'Alexa.Speaker') {
      return await handleSpeakerController(event);
    }

    if (namespace === 'Alexa.PlaybackController') {
      return await handlePlaybackController(event);
    }

    if (namespace === 'Alexa.OpenCloseController') {
      return await handleOpenCloseController(event);
    }

    if (namespace === 'Alexa.ThermostatController') {
      return await handleThermostatController(event);
    }

    if (namespace === 'Alexa.RangeController') {
      return await handleRangeController(event);
    }

    if (namespace === 'Alexa' && name === 'ReportState') {
      return await handleReportState(event);
    }

    console.warn('Unsupported directive', namespace, name);
    return buildErrorResponse(
      directive,
      'INVALID_DIRECTIVE',
      `Unsupported directive ${namespace}.${name}`
    );
  } catch (err: any) {
    console.error('Handler error', err);

    if (err instanceof AlexaAuthError) {
      return buildErrorResponse(
        directive,
        err.alexaType,
        'Authorization failed'
      );
    }

    return buildErrorResponse(
      directive,
      'INTERNAL_ERROR',
      'Internal error'
    );
  }
};

async function handleAskSkillEvent(event: any): Promise<void> {
  const requestType = String(event?.request?.type ?? '');
  const backendBase = DINODIA_BACKEND_BASE_URL;
  const internalSecret = ALEXA_SKILL_EVENTS_INTERNAL_SECRET;

  const alexaUserId =
    typeof event?.context?.System?.user?.userId === 'string'
      ? event.context.System.user.userId
      : '';
  const requestId = typeof event?.request?.requestId === 'string' ? event.request.requestId : null;
  const timestamp = typeof event?.request?.timestamp === 'string' ? event.request.timestamp : null;
  const locale =
    typeof event?.request?.locale === 'string'
      ? event.request.locale
      : typeof event?.context?.System?.device?.locale === 'string'
      ? event.context.System.device.locale
      : null;
  const marketplace =
    typeof event?.request?.marketplace === 'string'
      ? event.request.marketplace
      : typeof event?.context?.System?.marketplace === 'string'
      ? event.context.System.marketplace
      : null;

  const skillId =
    typeof event?.context?.System?.application?.applicationId === 'string'
      ? event.context.System.application.applicationId
      : null;

  if (!backendBase || !internalSecret || !alexaUserId) {
    console.error('ASK Skill Event: missing required env/fields', {
      hasBackendBase: !!backendBase,
      hasInternalSecret: !!internalSecret,
      hasAlexaUserId: !!alexaUserId,
      requestType,
    });
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${internalSecret}`,
  };

  if (requestType === 'AlexaSkillEvent.SkillAccountLinked') {
    const accessTokenRaw = event?.request?.body?.accessToken;
    const accessToken = typeof accessTokenRaw === 'string' ? accessTokenRaw.trim() : '';
    if (!accessToken) {
      console.error('SkillAccountLinked: missing accessToken');
      return;
    }
    await fetch(`${backendBase}/api/internal/alexa/skill-events/account-linked`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        alexaUserId,
        skillId,
        marketplace,
        locale,
        requestId,
        timestamp,
        accessToken,
      }),
    }).catch((err) => console.error('SkillAccountLinked -> backend failed', err));
    return;
  }

  if (requestType === 'AlexaSkillEvent.SkillAccountUnlinked') {
    await fetch(`${backendBase}/api/internal/alexa/skill-events/account-unlinked`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        alexaUserId,
        skillId,
        marketplace,
        locale,
        requestId,
        timestamp,
      }),
    }).catch((err) => console.error('SkillAccountUnlinked -> backend failed', err));
    return;
  }

  if (requestType === 'AlexaSkillEvent.SkillDisabled') {
    await fetch(`${backendBase}/api/internal/alexa/skill-events/skill-disabled`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        alexaUserId,
        skillId,
        marketplace,
        locale,
        requestId,
        timestamp,
        reason: 'SKILL_DISABLED',
      }),
    }).catch((err) => console.error('SkillDisabled -> backend failed', err));
    return;
  }

  console.log('ASK Skill Event: ignored', { requestType });
}
