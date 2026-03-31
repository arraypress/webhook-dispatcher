# @arraypress/webhook-dispatcher

Dispatch webhook events to endpoints with HMAC-SHA256 signing. Three functions, zero dependencies.

Uses the Web Crypto API — works in Cloudflare Workers, Node.js 18+, Deno, Bun, and browsers.

## Installation

```bash
npm install @arraypress/webhook-dispatcher
```

## Usage

```js
import { dispatch } from '@arraypress/webhook-dispatcher';

await dispatch({
  endpoints: [
    { url: 'https://example.com/hook', secret: 'whsec_abc123' },
    { url: 'https://other.com/hook', secret: 'whsec_def456' },
  ],
  event: 'order.completed',
  data: { orderId: 'pi_123', amount: 2999 },
});
```

Each endpoint receives a POST with:

```json
{
  "event": "order.completed",
  "created_at": "2024-01-01T00:00:00.000Z",
  "data": { "orderId": "pi_123", "amount": 2999 }
}
```

And these headers:

```
Content-Type: application/json
X-Webhook-Event: order.completed
X-Webhook-Signature: sha256=a1b2c3...
X-Webhook-Timestamp: 1700000000
X-Webhook-Delivery: 550e8400-e29b-...
```

## API

### `dispatch(options)`

Deliver an event to all endpoints concurrently. Never throws.

```js
const results = await dispatch({
  endpoints,           // Array of { url, secret, headers? }
  event: 'order.completed',
  data: { id: 1 },
  onDelivery: (result, endpoint) => { /* log to DB */ },
  timeout: 10000,      // Per-endpoint timeout (default 10s)
  headerPrefix: 'X-Webhook',  // Header prefix (default "X-Webhook")
});
```

Returns an array of delivery results:

```js
[{
  deliveryId: '550e8400-...',
  endpointUrl: 'https://example.com/hook',
  event: 'order.completed',
  success: true,
  responseStatus: 200,
  responseBody: 'ok',
  durationMs: 150,
}]
```

### `deliverToEndpoint(endpoint, eventName, bodyStr, options?)`

Low-level: deliver a pre-serialized body to a single endpoint. Useful when you want to control the envelope format.

```js
import { deliverToEndpoint } from '@arraypress/webhook-dispatcher';

const body = JSON.stringify({ custom: 'envelope', data: { id: 1 } });
const result = await deliverToEndpoint(
  { url: 'https://example.com/hook', secret: 'whsec_abc' },
  'order.completed',
  body
);
```

### `signPayload(secret, timestamp, body)`

Low-level: generate an HMAC-SHA256 signature. The signed message is `${timestamp}.${body}`.

```js
import { signPayload } from '@arraypress/webhook-dispatcher';

const sig = await signPayload('whsec_abc', Math.floor(Date.now() / 1000), bodyStr);
// → 'sha256=a1b2c3...'
```

## Logging Deliveries

Use the `onDelivery` callback to log delivery attempts to your database:

```js
await dispatch({
  endpoints,
  event: 'order.completed',
  data: orderPayload,
  onDelivery: async (result, endpoint) => {
    await db.prepare(
      'INSERT INTO webhook_deliveries (endpoint_id, event, success, status, duration_ms) VALUES (?, ?, ?, ?, ?)'
    ).bind(endpoint.id, result.event, result.success, result.responseStatus, result.durationMs).run();
  },
});
```

## Custom Header Prefix

```js
await dispatch({
  endpoints,
  event: 'payment.received',
  data: { id: 1 },
  headerPrefix: 'X-FlareCart',
});
// Headers: X-FlareCart-Event, X-FlareCart-Signature, X-FlareCart-Timestamp, X-FlareCart-Delivery
```

## Verifying Signatures (Receiver Side)

To verify incoming webhooks, reconstruct the signed message and compare:

```js
const timestamp = request.headers.get('X-Webhook-Timestamp');
const signature = request.headers.get('X-Webhook-Signature');
const body = await request.text();

const expected = await signPayload(secret, Number(timestamp), body);
const valid = signature === expected;
```

## License

MIT
