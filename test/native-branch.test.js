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

test('Alexa discovery uses the native Dinodia OS projection when available', async () => {
  const calls = [];
  const nativeResponse = discoveryFixture;
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
    assert.equal(JSON.stringify(result).includes(discoveryFixture.properties[0].data[0].id), false);
    assert.equal(calls[0], 'https://dinodia-platform-v2.vercel.app/api/v2/alexa/discovery');
  } finally {
    global.fetch = originalFetch;
  }
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
