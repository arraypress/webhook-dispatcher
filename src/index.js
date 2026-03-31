/**
 * @arraypress/webhook-dispatcher
 *
 * Dispatch webhook events to endpoints with HMAC-SHA256 signing.
 *
 * Provides two levels of abstraction:
 *   - `dispatch()` — High-level: pass endpoints and data, get signed deliveries.
 *   - `signPayload()` / `deliverToEndpoint()` — Low-level building blocks.
 *
 * All errors are caught — webhook delivery never throws.
 *
 * Zero dependencies. Uses the Web Crypto API — works in Cloudflare Workers,
 * Node.js 18+, Deno, Bun, and browsers.
 *
 * @module @arraypress/webhook-dispatcher
 */

/**
 * Sign a payload with HMAC-SHA256.
 *
 * Produces a signature in the format `sha256=<hex>` suitable for
 * webhook signature headers.
 *
 * The signed message is `${timestamp}.${body}` to prevent replay attacks.
 *
 * @param {string} secret - The endpoint's signing secret.
 * @param {number} timestamp - Unix timestamp in seconds.
 * @param {string} body - The raw JSON body string.
 * @returns {Promise<string>} Signature in "sha256=<hex>" format.
 *
 * @example
 * const sig = await signPayload('whsec_abc123', 1700000000, '{"event":"order.completed"}');
 * // → 'sha256=a1b2c3...'
 */
export async function signPayload(secret, timestamp, body) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = `${timestamp}.${body}`;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const hex = [...new Uint8Array(signature)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

/**
 * Deliver a webhook to a single endpoint.
 *
 * Signs the payload, sends the POST request, and returns a delivery
 * result object. Never throws.
 *
 * @param {Object} endpoint - The endpoint to deliver to.
 * @param {string} endpoint.url - The endpoint URL.
 * @param {string} endpoint.secret - The HMAC signing secret.
 * @param {string|Object} [endpoint.headers] - Custom headers (JSON string or object).
 * @param {string} eventName - The event name (e.g. "order.completed").
 * @param {string} bodyStr - Pre-serialized JSON body.
 * @param {Object} [options] - Delivery options.
 * @param {number} [options.timeout] - Request timeout in ms (default 10000).
 * @param {string} [options.headerPrefix] - Prefix for signature headers (default "X-Webhook").
 * @returns {Promise<Object>} Delivery result with success, responseStatus, responseBody, durationMs.
 *
 * @example
 * const result = await deliverToEndpoint(
 *   { url: 'https://example.com/hook', secret: 'whsec_abc' },
 *   'order.completed',
 *   JSON.stringify({ event: 'order.completed', data: { id: 1 } })
 * );
 * // { success: true, responseStatus: 200, responseBody: 'ok', durationMs: 150, deliveryId: '...' }
 */
export async function deliverToEndpoint(endpoint, eventName, bodyStr, options = {}) {
  const timeout = options.timeout || 10000;
  const prefix = options.headerPrefix || 'X-Webhook';
  const timestamp = Math.floor(Date.now() / 1000);
  const deliveryId = crypto.randomUUID();
  const start = Date.now();

  let responseStatus = 0;
  let responseBody = '';
  let success = false;

  try {
    const signature = await signPayload(endpoint.secret, timestamp, bodyStr);

    // Parse custom headers if stored as JSON string
    const customHeaders = typeof endpoint.headers === 'string'
      ? JSON.parse(endpoint.headers || '{}')
      : (endpoint.headers || {});

    const headers = {
      'Content-Type': 'application/json',
      [`${prefix}-Event`]: eventName,
      [`${prefix}-Signature`]: signature,
      [`${prefix}-Timestamp`]: String(timestamp),
      [`${prefix}-Delivery`]: deliveryId,
      ...customHeaders,
    };

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(timeout),
    });

    responseStatus = response.status;
    responseBody = await response.text().catch(() => '');
    success = response.ok;
  } catch (err) {
    responseBody = err.message || 'Delivery failed';
  }

  return {
    deliveryId,
    endpointUrl: endpoint.url,
    event: eventName,
    success,
    responseStatus,
    responseBody,
    durationMs: Date.now() - start,
  };
}

/**
 * Dispatch a webhook event to multiple endpoints.
 *
 * Wraps the data in an envelope `{ event, created_at, data }`, delivers
 * to all endpoints concurrently, and optionally calls `onDelivery` for
 * each result (e.g. to log to a database).
 *
 * Never throws — all errors are caught and reported in delivery results.
 *
 * @param {Object} options
 * @param {Array<Object>} options.endpoints - Endpoints to deliver to. Each needs `url` and `secret`.
 * @param {string} options.event - The event name (e.g. "order.completed").
 * @param {Object} options.data - The event payload data.
 * @param {Function} [options.onDelivery] - Callback called with each delivery result. Can be async.
 * @param {number} [options.timeout] - Per-endpoint timeout in ms (default 10000).
 * @param {string} [options.headerPrefix] - Prefix for signature headers (default "X-Webhook").
 * @returns {Promise<Array<Object>>} Array of delivery results.
 *
 * @example
 * // Simple dispatch
 * const results = await dispatch({
 *   endpoints: [
 *     { url: 'https://example.com/hook', secret: 'whsec_abc' },
 *     { url: 'https://other.com/hook', secret: 'whsec_def' },
 *   ],
 *   event: 'order.completed',
 *   data: { orderId: 'pi_123', amount: 2999 },
 * });
 *
 * @example
 * // With delivery logging
 * await dispatch({
 *   endpoints,
 *   event: 'order.completed',
 *   data: orderPayload,
 *   onDelivery: (result) => {
 *     db.prepare('INSERT INTO webhook_deliveries ...')
 *       .bind(result.event, result.success, result.responseStatus)
 *       .run();
 *   },
 * });
 *
 * @example
 * // Custom header prefix
 * await dispatch({
 *   endpoints,
 *   event: 'payment.received',
 *   data: { id: 1 },
 *   headerPrefix: 'X-FlareCart',
 * });
 * // Headers: X-FlareCart-Event, X-FlareCart-Signature, etc.
 */
export async function dispatch({ endpoints, event, data, onDelivery, timeout, headerPrefix }) {
  if (!endpoints || !endpoints.length) return [];

  const envelope = {
    event,
    created_at: new Date().toISOString(),
    data,
  };
  const bodyStr = JSON.stringify(envelope);
  const deliveryOptions = { timeout, headerPrefix };

  const results = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const result = await deliverToEndpoint(ep, event, bodyStr, deliveryOptions);

      if (onDelivery) {
        try {
          await onDelivery(result, ep);
        } catch (err) {
          // Never let logging break the dispatch
          console.warn('onDelivery callback failed:', err.message);
        }
      }

      return result;
    })
  );

  return results.map(r => r.status === 'fulfilled' ? r.value : {
    success: false,
    responseStatus: 0,
    responseBody: r.reason?.message || 'Unknown error',
    durationMs: 0,
  });
}
