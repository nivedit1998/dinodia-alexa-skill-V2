const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DINODIA_API_BASE_URL = 'https://dinodia-platform-v2.vercel.app';
const { handler } = require('../dist/index.js');
const discoveryFixture = require('./fixtures/dinodia-v1/fixtures/alexa-discovery-projection.json');

function directive(namespace, name, endpointId) {
  return {
    directive: {
      header: { namespace, name, messageId: 'message-1', payloadVersion: '3' },
      endpoint: endpointId ? { endpointId, scope: { type: 'BearerToken', token: 'access-token' } } : undefined,
      payload: endpointId ? {} : { scope: { type: 'BearerToken', token: 'access-token' } },
    },
  };
}

function rangeControl(device, controlId, sortOrder = 3) {
  return {
    schemaVersion: 1, deviceId: device.id, controlId, label: 'Position', group: 'Blind', sortOrder,
    valueType: 'number', interactionKind: 'slider', semanticRole: 'position', readable: true, writable: true,
    automatable: true, observable: true, idempotency: 'set_value', confirmationPolicy: 'matching_observation',
    riskLevel: 'normal', stepUpPolicy: 'none', catalogRevision: device.descriptorRevision,
    expectedReportingIntervalSeconds: 60, maxStateValiditySeconds: 180,
    constraints: { minimum: 0, maximum: 100, step: 5, unit: 'percent' }, unsupportedReason: null,
  };
}

test('Alexa discovery uses the native Dinodia OS projection when available', async () => {
  const calls = [];
  const nativeResponse = structuredClone(discoveryFixture);
  nativeResponse.properties[0].data[0].controls.push(rangeControl(nativeResponse.properties[0].data[0], 'control:position'));
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(nativeResponse), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await handler(directive('Alexa.Discovery', 'Discover'));
    const endpoints = result.event.payload.endpoints;
    assert.equal(endpoints.length, 2);
    assert.equal(endpoints[0].endpointId, discoveryFixture.properties[0].data[0].endpointId, 'the skill forwards the Platform-owned ID unchanged');
    assert.equal(endpoints[0].friendlyName, discoveryFixture.properties[0].data[0].friendlyName);
    assert.ok(endpoints[0].capabilities.some((capability) => capability.interface === 'Alexa.PowerController'));
    assert.ok(endpoints[0].capabilities.some((capability) => capability.interface === 'Alexa.BrightnessController'));
    for (const endpoint of endpoints) {
      assert.ok(endpoint.capabilities.length > 0);
      for (const capability of endpoint.capabilities) {
      assert.equal(capability.type, 'AlexaInterface', `capability ${capability.interface} declares its wire type`);
      assert.equal(typeof capability.interface, 'string');
      assert.equal(capability.version, '3');
      if (capability.interface === 'Alexa.EndpointHealth') assert.deepEqual(capability.properties?.supported, [{ name: 'connectivity' }]);
      if (capability.interface === 'Alexa.PowerController') assert.deepEqual(capability.properties?.supported, [{ name: 'powerState' }]);
      if (capability.interface === 'Alexa.BrightnessController') assert.deepEqual(capability.properties?.supported, [{ name: 'brightness' }]);
      if (capability.interface === 'Alexa.ThermostatController') {
        assert.deepEqual(capability.properties?.supported, [{ name: 'targetSetpoint' }]);
        assert.equal(Object.hasOwn(capability, 'configuration'), false, 'setpoint-only V3 does not emit unsupported mode configuration');
      }
      if (capability.interface === 'Alexa.TemperatureSensor') assert.deepEqual(capability.properties?.supported, [{ name: 'temperature' }]);
      if (capability.interface === 'Alexa.RangeController') {
        assert.equal(typeof capability.instance, 'string');
        assert.deepEqual(capability.properties?.supported, [{ name: 'rangeValue' }]);
        assert.ok(Number.isFinite(capability.configuration?.supportedRange?.precision));
        assert.ok(Number.isFinite(capability.configuration?.supportedRange?.minimumValue));
        assert.ok(Number.isFinite(capability.configuration?.supportedRange?.maximumValue));
      }
      }
      assert.equal(endpoint.capabilities.some((capability) => /LockController|SecurityPanel/i.test(capability.interface)), false,
        'app-only lock/security controls are never advertised');
    }
    const range = endpoints.flatMap((endpoint) => endpoint.capabilities).find((capability) => capability.interface === 'Alexa.RangeController');
    if (range) {
      assert.equal(range.instance, 'Dinodia.Position');
      assert.equal(typeof range.capabilityResources?.friendlyNames?.[0]?.value?.text, 'string');
      assert.ok(Number.isFinite(range.configuration?.supportedRange?.minimumValue));
      assert.ok(Number.isFinite(range.configuration?.supportedRange?.maximumValue));
      assert.ok(Number.isFinite(range.configuration?.supportedRange?.precision));
      assert.equal(range.configuration.unitOfMeasure, 'Alexa.Unit.Percent');
      assert.equal(Object.hasOwn(range, 'unitOfMeasure'), false, 'unit is nested under RangeController configuration');
    }
    assert.equal(JSON.stringify(result).includes(discoveryFixture.properties[0].data[0].id), false);
    assert.equal(calls[0], 'https://dinodia-platform-v2.vercel.app/api/v2/alexa/discovery');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Alexa discovery gives same-interface range controls distinct stable instances', async () => {
  const calls = [];
  const fixture = structuredClone(discoveryFixture);
  const device = fixture.properties[0].data[0];
  const primary = rangeControl(device, 'control:position');
  device.controls.push(primary);
  const duplicate = { ...primary, controlId: `${primary.controlId}:second`, label: 'Second position', sortOrder: primary.sortOrder + 1 };
  device.controls.push(duplicate);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await handler(directive('Alexa.Discovery', 'Discover'));
    const endpoint = result.event.payload.endpoints.find((item) => item.endpointId === device.endpointId);
    const ranges = endpoint.capabilities.filter((capability) => capability.interface === 'Alexa.RangeController');
    assert.equal(ranges.length, 2);
    assert.equal(new Set(ranges.map((item) => item.instance)).size, 2);
    assert.ok(ranges.every((item) => item.type === 'AlexaInterface' && item.configuration?.supportedRange));
    assert.deepEqual(calls, ['https://dinodia-platform-v2.vercel.app/api/v2/alexa/discovery']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('packaged discovery emits provider-valid setpoint-only thermostat and temperature-sensor wire shapes', async () => {
  const fixture = structuredClone(discoveryFixture);
  const thermostat = fixture.properties[0].data[0];
  thermostat.controls = [{
    schemaVersion: 1, deviceId: thermostat.id, controlId: 'control:target-temperature', label: 'Target temperature', sortOrder: 0,
    valueType: 'number', interactionKind: 'slider', semanticRole: 'target_temperature', readable: true, writable: true,
    automatable: true, observable: true, idempotency: 'set_value', confirmationPolicy: 'matching_observation',
    riskLevel: 'normal', stepUpPolicy: 'none', constraints: { minimum: 5, maximum: 35, step: 0.5, unit: 'celsius' },
    catalogRevision: thermostat.descriptorRevision, expectedReportingIntervalSeconds: 60, maxStateValiditySeconds: 180,
  }];
  const sensor = structuredClone(fixture.properties[0].data[1]);
  sensor.id = 'device:temperature-sensor-only';
  sensor.endpointId = 'dos_' + 'c'.repeat(64);
  sensor.controls = [{
    schemaVersion: 1, deviceId: sensor.id, controlId: 'control:ambient-temperature', label: 'Temperature', sortOrder: 0,
    valueType: 'number', interactionKind: 'read_only', semanticRole: 'ambient_temperature', readable: true, writable: false,
    automatable: false, observable: true, idempotency: 'none', confirmationPolicy: 'none',
    riskLevel: 'low', stepUpPolicy: 'none', constraints: { minimum: -40, maximum: 100, step: 0.1, unit: 'celsius' },
    catalogRevision: sensor.descriptorRevision, expectedReportingIntervalSeconds: 60, maxStateValiditySeconds: 180,
  }];
  fixture.properties[0].data = [thermostat, sensor];
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await handler(directive('Alexa.Discovery', 'Discover'));
    const thermostatEndpoint = result.event.payload.endpoints.find((item) => item.endpointId === thermostat.endpointId);
    const thermostatCapability = thermostatEndpoint.capabilities.find((item) => item.interface === 'Alexa.ThermostatController');
    assert.deepEqual(thermostatEndpoint.displayCategories, ['THERMOSTAT']);
    assert.deepEqual(thermostatCapability.properties.supported, [{ name: 'targetSetpoint' }]);
    assert.equal(Object.hasOwn(thermostatCapability, 'configuration'), false, 'setpoint-only device does not advertise invented mode support');
    const sensorEndpoint = result.event.payload.endpoints.find((item) => item.endpointId === sensor.endpointId);
    assert.deepEqual(sensorEndpoint.displayCategories, ['TEMPERATURE_SENSOR']);
    assert.ok(sensorEndpoint.capabilities.some((item) => item.interface === 'Alexa.TemperatureSensor'
      && item.properties.supported.some((property) => property.name === 'temperature')));
    assert.equal(sensorEndpoint.capabilities.some((item) => item.interface === 'Alexa.ThermostatController'), false);
    for (const endpoint of result.event.payload.endpoints) {
      for (const capability of endpoint.capabilities) {
        assert.equal(capability.type, 'AlexaInterface');
        assert.equal(typeof capability.version, 'string');
        assert.ok(capability.properties === undefined || Array.isArray(capability.properties.supported));
      }
    }
  } finally { global.fetch = originalFetch; }
});

test('Alexa discovery fails closed when Platform omits its endpoint identity', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  const { properties, ...nativeResponse } = discoveryFixture;
  global.fetch = async (url) => {
    calls.push(String(url));
    const body = { ...nativeResponse, properties: properties.map((property) => ({ ...property, data: property.data.map(({ endpointId, ...device }) => device) })) };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await handler(directive('Alexa.Discovery', 'Discover'));
    assert.equal(result.event.payload.type, 'ENDPOINT_UNREACHABLE');
    assert.deepEqual(calls, ['https://dinodia-platform-v2.vercel.app/api/v2/alexa/discovery']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('dos_ directives are forwarded to native Dinodia OS routing', async () => {
  const endpointId = 'dos_' + 'b'.repeat(64);
  const calls = [];
  const nativeResponse = { context: { properties: [] }, event: { header: { namespace: 'Alexa', name: 'Response' }, endpoint: { endpointId } } };
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(nativeResponse), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await handler(directive('Alexa.PowerController', 'TurnOn', endpointId));
    assert.deepEqual(result, nativeResponse);
    assert.equal(calls[0].url, 'https://dinodia-platform-v2.vercel.app/api/v2/alexa/directives');
    assert.equal(JSON.parse(calls[0].options.body).directive.endpoint.endpointId, endpointId);
  } finally {
    global.fetch = originalFetch;
  }
});

test('RangeController header instance is forwarded unchanged to the canonical Platform route', async () => {
  const endpointId = 'dos_' + 'd'.repeat(64);
  const event = directive('Alexa.RangeController', 'SetRangeValue', endpointId);
  event.directive.header.instance = 'Dinodia.Position';
  event.directive.payload = { rangeValue: 50 };
  const calls = [];
  const nativeResponse = { event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3' }, endpoint: { endpointId }, payload: {} } };
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(nativeResponse), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await handler(event);
    const forwarded = JSON.parse(calls[0].options.body).directive;
    assert.deepEqual(result, nativeResponse);
    assert.equal(calls[0].url, 'https://dinodia-platform-v2.vercel.app/api/v2/alexa/directives');
    assert.equal(forwarded.header.instance, 'Dinodia.Position');
    assert.deepEqual(forwarded.payload, { rangeValue: 50 });
  } finally {
    global.fetch = originalFetch;
  }
});

test('successful ReportState result is forwarded as the Platform StateReport unchanged', async () => {
  const endpointId = 'dos_' + 'e'.repeat(64);
  const event = directive('Alexa', 'ReportState', endpointId);
  event.directive.header.correlationToken = 'correlation-state-report';
  const stateReport = { event: { header: { namespace: 'Alexa', name: 'StateReport', correlationToken: 'correlation-state-report', payloadVersion: '3' }, endpoint: { endpointId }, payload: {} }, context: { properties: [] } };
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(stateReport), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await handler(event);
    assert.deepEqual(result, stateReport);
    assert.equal(calls[0].url, 'https://dinodia-platform-v2.vercel.app/api/v2/alexa/report-state');
    assert.equal(JSON.parse(calls[0].options.body).directive.header.correlationToken, 'correlation-state-report');
  } finally {
    global.fetch = originalFetch;
  }
});

test('production refuses an alternate Alexa backend origin at module initialization', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', "process.env.NODE_ENV='production';process.env.DINODIA_API_BASE_URL='https://unapproved.example';require('./dist/index.js')"], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical Native V2 Platform origin/);
});

test('native discovery failure is returned without falling back to the legacy device endpoint', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return new Response('{"error":"unavailable"}', { status: 503 }); };
  try {
    const result = await handler(directive('Alexa.Discovery', 'Discover'));
    assert.equal(result.event.payload.type, 'ENDPOINT_UNREACHABLE');
    assert.deepEqual(calls, ['https://dinodia-platform-v2.vercel.app/api/v2/alexa/discovery']);
  } finally { global.fetch = originalFetch; }
});

test('global Alexa activation hold is truthful and never reaches legacy routes', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return new Response('{"error":"feature_disabled"}', { status: 501 }); };
  try {
    const discovery = await handler(directive('Alexa.Discovery', 'Discover'));
    assert.equal(discovery.event.payload.type, 'NOT_SUPPORTED_IN_CURRENT_MODE');
    const directiveResult = await handler(directive('Alexa.PowerController', 'TurnOn', 'dos_' + 'c'.repeat(64)));
    assert.equal(directiveResult.event.payload.type, 'NOT_SUPPORTED_IN_CURRENT_MODE');
    assert.deepEqual(calls, [
      'https://dinodia-platform-v2.vercel.app/api/v2/alexa/discovery',
      'https://dinodia-platform-v2.vercel.app/api/v2/alexa/directives',
    ]);
  } finally { global.fetch = originalFetch; }
});

test('AcceptGrant sends its bounded code and linked Dinodia token to canonical Platform', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => { calls.push({ url: String(url), options }); return new Response('{"accepted":true}', { status: 200 }); };
  try {
    const accepted = await handler({ directive: { header: { namespace: 'Alexa.Authorization', name: 'AcceptGrant', messageId: 'grant-test', payloadVersion: '3' }, payload: { grant: { type: 'OAuth2.AuthorizationCode', code: 'disposable-code' }, grantee: { type: 'BearerToken', token: 'dno-customer-access-123456789012345678901234567890' } } } });
    assert.equal(accepted.event.header.namespace, 'Alexa.Authorization');
    assert.equal(accepted.event.header.name, 'AcceptGrant.Response');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://dinodia-platform-v2.vercel.app/api/v2/alexa/accept-grant');
    assert.equal(calls[0].options.headers.authorization, 'Bearer dno-customer-access-123456789012345678901234567890');
    assert.deepEqual(JSON.parse(calls[0].options.body), { messageId: 'grant-test', grantCode: 'disposable-code' });
    const queueEvent = await handler({ Records: [{ eventSource: 'aws:sqs', body: '{"testOnly":true}' }] });
    assert.equal(queueEvent, undefined);
  } finally { global.fetch = originalFetch; }
});

test('AcceptGrant fails closed when provider exchange is unavailable or malformed', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response('{"error":"unavailable"}', { status: 503 }); };
  try {
    const failed = await handler({ directive: { header: { namespace: 'Alexa.Authorization', name: 'AcceptGrant', messageId: 'grant-failure', payloadVersion: '3' }, payload: { grant: { type: 'OAuth2.AuthorizationCode', code: 'valid-shaped-code' }, grantee: { type: 'BearerToken', token: 'dno-customer-access-123456789012345678901234567890' } } } });
    assert.equal(failed.event.header.name, 'ErrorResponse');
    assert.equal(failed.event.payload.type, 'ACCEPT_GRANT_FAILED');
    const malformed = await handler({ directive: { header: { namespace: 'Alexa.Authorization', name: 'AcceptGrant', messageId: 'grant-invalid', payloadVersion: '3' }, payload: { grant: { code: 'missing-type' }, grantee: { type: 'BearerToken', token: 'dno-customer-access-123456789012345678901234567890' } } } });
    assert.equal(malformed.event.payload.type, 'ACCEPT_GRANT_FAILED');
    assert.equal(calls, 1, 'malformed grant did not reach Platform');
  } finally { global.fetch = originalFetch; }
});

test('legacy ha_ endpoint IDs are rejected without contacting a backend', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 200 }); };
  try {
    const result = await handler(directive('Alexa.PowerController', 'TurnOn', 'ha_' + 'a'.repeat(64)));
    assert.equal(calls.length, 0);
    assert.ok(result.event);
  } finally { global.fetch = originalFetch; }
});
