import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload, deliverToEndpoint, dispatch, verifyPayload } from '../src/index.js';

// ── Mock fetch ─────────────────────────────────

let originalFetch;
let mockFetchHandler;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockFetchHandler = () => ({
    ok: true,
    status: 200,
    text: async () => 'ok',
  });
  globalThis.fetch = async (url, opts) => {
    globalThis.fetch.calls = globalThis.fetch.calls || [];
    globalThis.fetch.calls.push({ url, opts });
    return mockFetchHandler(url, opts);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mockFetchHandler = null;
});

// ── signPayload ────────────────────────────────

describe('signPayload', () => {
  it('produces sha256= prefixed hex string', async () => {
    const sig = await signPayload('secret', 1700000000, '{"test":true}');
    assert.match(sig, /^sha256=[a-f0-9]{64}$/);
  });

  it('same inputs produce same signature', async () => {
    const a = await signPayload('secret', 1700000000, 'body');
    const b = await signPayload('secret', 1700000000, 'body');
    assert.equal(a, b);
  });

  it('different secrets produce different signatures', async () => {
    const a = await signPayload('secret-a', 1700000000, 'body');
    const b = await signPayload('secret-b', 1700000000, 'body');
    assert.notEqual(a, b);
  });

  it('different timestamps produce different signatures', async () => {
    const a = await signPayload('secret', 1700000000, 'body');
    const b = await signPayload('secret', 1700000001, 'body');
    assert.notEqual(a, b);
  });

  it('different bodies produce different signatures', async () => {
    const a = await signPayload('secret', 1700000000, 'body-a');
    const b = await signPayload('secret', 1700000000, 'body-b');
    assert.notEqual(a, b);
  });
});

// ── deliverToEndpoint ──────────────────────────

describe('deliverToEndpoint', () => {
  const endpoint = { url: 'https://example.com/hook', secret: 'whsec_test' };

  it('returns success on 200', async () => {
    const result = await deliverToEndpoint(endpoint, 'order.completed', '{}');
    assert.equal(result.success, true);
    assert.equal(result.responseStatus, 200);
    assert.equal(result.responseBody, 'ok');
    assert.equal(result.event, 'order.completed');
    assert.equal(result.endpointUrl, 'https://example.com/hook');
    assert.ok(result.deliveryId);
    assert.ok(result.durationMs >= 0);
  });

  it('returns failure on 500', async () => {
    mockFetchHandler = () => ({ ok: false, status: 500, text: async () => 'Internal error' });
    const result = await deliverToEndpoint(endpoint, 'test', '{}');
    assert.equal(result.success, false);
    assert.equal(result.responseStatus, 500);
    assert.equal(result.responseBody, 'Internal error');
  });

  it('returns failure on network error', async () => {
    globalThis.fetch = async () => { throw new Error('Connection refused'); };
    const result = await deliverToEndpoint(endpoint, 'test', '{}');
    assert.equal(result.success, false);
    assert.equal(result.responseStatus, 0);
    assert.equal(result.responseBody, 'Connection refused');
  });

  it('sends correct headers with default prefix', async () => {
    await deliverToEndpoint(endpoint, 'order.completed', '{"test":true}');
    const { opts } = globalThis.fetch.calls[0];
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.equal(opts.headers['X-Webhook-Event'], 'order.completed');
    assert.match(opts.headers['X-Webhook-Signature'], /^sha256=/);
    assert.ok(opts.headers['X-Webhook-Timestamp']);
    assert.ok(opts.headers['X-Webhook-Delivery']);
  });

  it('uses custom header prefix', async () => {
    await deliverToEndpoint(endpoint, 'test', '{}', { headerPrefix: 'X-FlareCart' });
    const { opts } = globalThis.fetch.calls[0];
    assert.equal(opts.headers['X-FlareCart-Event'], 'test');
    assert.match(opts.headers['X-FlareCart-Signature'], /^sha256=/);
    assert.ok(opts.headers['X-FlareCart-Timestamp']);
    assert.ok(opts.headers['X-FlareCart-Delivery']);
  });

  it('includes custom endpoint headers (object)', async () => {
    const ep = { ...endpoint, headers: { Authorization: 'Bearer xyz' } };
    await deliverToEndpoint(ep, 'test', '{}');
    const { opts } = globalThis.fetch.calls[0];
    assert.equal(opts.headers['Authorization'], 'Bearer xyz');
  });

  it('includes custom endpoint headers (JSON string)', async () => {
    const ep = { ...endpoint, headers: '{"X-Custom":"value"}' };
    await deliverToEndpoint(ep, 'test', '{}');
    const { opts } = globalThis.fetch.calls[0];
    assert.equal(opts.headers['X-Custom'], 'value');
  });

  it('sends POST request to endpoint URL', async () => {
    await deliverToEndpoint(endpoint, 'test', '{"data":1}');
    const { url, opts } = globalThis.fetch.calls[0];
    assert.equal(url, 'https://example.com/hook');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.body, '{"data":1}');
  });
});

// ── dispatch ───────────────────────────────────

describe('dispatch', () => {
  const endpoints = [
    { url: 'https://a.com/hook', secret: 'secret-a' },
    { url: 'https://b.com/hook', secret: 'secret-b' },
  ];

  it('returns empty array when no endpoints', async () => {
    const results = await dispatch({ endpoints: [], event: 'test', data: {} });
    assert.deepEqual(results, []);
  });

  it('returns empty array when endpoints is null', async () => {
    const results = await dispatch({ endpoints: null, event: 'test', data: {} });
    assert.deepEqual(results, []);
  });

  it('delivers to all endpoints', async () => {
    const results = await dispatch({ endpoints, event: 'order.completed', data: { id: 1 } });
    assert.equal(results.length, 2);
    assert.equal(results[0].success, true);
    assert.equal(results[1].success, true);
    assert.equal(globalThis.fetch.calls.length, 2);
  });

  it('wraps data in envelope with event and created_at', async () => {
    await dispatch({ endpoints: [endpoints[0]], event: 'test.event', data: { foo: 'bar' } });
    const body = JSON.parse(globalThis.fetch.calls[0].opts.body);
    assert.equal(body.event, 'test.event');
    assert.ok(body.created_at);
    assert.deepEqual(body.data, { foo: 'bar' });
  });

  it('calls onDelivery for each endpoint', async () => {
    const deliveries = [];
    await dispatch({
      endpoints,
      event: 'test',
      data: {},
      onDelivery: (result, ep) => {
        deliveries.push({ url: ep.url, success: result.success });
      },
    });
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].url, 'https://a.com/hook');
    assert.equal(deliveries[1].url, 'https://b.com/hook');
  });

  it('handles partial failures gracefully', async () => {
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount++;
      if (url === 'https://a.com/hook') throw new Error('Timeout');
      return { ok: true, status: 200, text: async () => 'ok' };
    };

    const results = await dispatch({ endpoints, event: 'test', data: {} });
    assert.equal(results.length, 2);
    assert.equal(results[0].success, false);
    assert.equal(results[1].success, true);
  });

  it('does not throw if onDelivery throws', async () => {
    const results = await dispatch({
      endpoints: [endpoints[0]],
      event: 'test',
      data: {},
      onDelivery: () => { throw new Error('Log failed'); },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
  });

  it('passes headerPrefix through to deliveries', async () => {
    await dispatch({
      endpoints: [endpoints[0]],
      event: 'test',
      data: {},
      headerPrefix: 'X-MyApp',
    });
    const { opts } = globalThis.fetch.calls[0];
    assert.equal(opts.headers['X-MyApp-Event'], 'test');
  });
});

// ── verifyPayload ──────────────────────────────

describe('verifyPayload', () => {
  const secret = 'whsec_test_secret';
  const body = '{"event":"order.completed","data":{"id":1}}';

  async function makeValidParams() {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signPayload(secret, Number(timestamp), body);
    return { body, signature, timestamp, secret };
  }

  it('returns valid for correct signature', async () => {
    const params = await makeValidParams();
    const result = await verifyPayload(params);
    assert.equal(result.valid, true);
    assert.equal(result.reason, undefined);
  });

  it('rejects wrong signature', async () => {
    const params = await makeValidParams();
    params.signature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';
    const result = await verifyPayload(params);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Signature mismatch');
  });

  it('rejects wrong secret', async () => {
    const params = await makeValidParams();
    params.secret = 'wrong_secret';
    const result = await verifyPayload(params);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Signature mismatch');
  });

  it('rejects tampered body', async () => {
    const params = await makeValidParams();
    params.body = '{"event":"order.completed","data":{"id":2}}';
    const result = await verifyPayload(params);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Signature mismatch');
  });

  it('rejects missing body', async () => {
    const params = await makeValidParams();
    params.body = '';
    const result = await verifyPayload(params);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Missing required fields');
  });

  it('rejects missing signature', async () => {
    const params = await makeValidParams();
    params.signature = '';
    const result = await verifyPayload(params);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Missing required fields');
  });

  it('rejects missing timestamp', async () => {
    const params = await makeValidParams();
    params.timestamp = '';
    const result = await verifyPayload(params);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Missing required fields');
  });

  it('rejects missing secret', async () => {
    const params = await makeValidParams();
    params.secret = '';
    const result = await verifyPayload(params);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Missing required fields');
  });

  it('rejects old timestamp beyond tolerance', async () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = await signPayload(secret, Number(oldTimestamp), body);
    const result = await verifyPayload({ body, signature, timestamp: oldTimestamp, secret });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Timestamp too old');
  });

  it('rejects future timestamp beyond tolerance', async () => {
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 600);
    const signature = await signPayload(secret, Number(futureTimestamp), body);
    const result = await verifyPayload({ body, signature, timestamp: futureTimestamp, secret });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Timestamp in the future');
  });

  it('accepts old timestamp when tolerance is 0', async () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 99999);
    const signature = await signPayload(secret, Number(oldTimestamp), body);
    const result = await verifyPayload({ body, signature, timestamp: oldTimestamp, secret, tolerance: 0 });
    assert.equal(result.valid, true);
  });

  it('accepts custom tolerance', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 500);
    const signature = await signPayload(secret, Number(ts), body);
    // Default 300s tolerance would reject, but 600s should accept
    const result = await verifyPayload({ body, signature, timestamp: ts, secret, tolerance: 600 });
    assert.equal(result.valid, true);
  });

  it('rejects invalid timestamp string', async () => {
    const params = await makeValidParams();
    params.timestamp = 'not-a-number';
    const result = await verifyPayload(params);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Invalid timestamp');
  });
});
