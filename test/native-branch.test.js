const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DINODIA_API_BASE_URL = 'https://platform.example';
const { handler } = require('../dist/index.js');

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
  const nativeResponse = { event: { header: { namespace: 'Alexa.Discovery', name: 'Discover.Response' }, payload: { endpoints: [{ endpointId: 'dos_' + 'a'.repeat(64) }] } } };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(nativeResponse), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await handler(directive('Alexa.Discovery', 'Discover'));
    assert.deepEqual(result, nativeResponse);
    assert.equal(calls[0], 'https://platform.example/api/alexa/v2/discovery');
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
    assert.equal(calls[0].url, 'https://platform.example/api/alexa/v2/directives');
    assert.equal(JSON.parse(calls[0].options.body).directive.endpoint.endpointId, endpointId);
  } finally {
    global.fetch = originalFetch;
  }
});
