export interface Endpoint {
  /** The endpoint URL. */
  url: string;
  /** The HMAC signing secret. */
  secret: string;
  /** Custom headers (JSON string or object). */
  headers?: string | Record<string, string>;
}

export interface DeliveryResult {
  /** Unique delivery ID. */
  deliveryId?: string;
  /** The endpoint URL. */
  endpointUrl?: string;
  /** The event name. */
  event?: string;
  /** Whether delivery succeeded (2xx response). */
  success: boolean;
  /** HTTP response status code (0 on network error). */
  responseStatus: number;
  /** Response body text or error message. */
  responseBody: string;
  /** Time taken in milliseconds. */
  durationMs: number;
}

export interface DeliveryOptions {
  /** Request timeout in ms (default 10000). */
  timeout?: number;
  /** Prefix for signature headers (default "X-Webhook"). */
  headerPrefix?: string;
}

export interface DispatchOptions {
  /** Endpoints to deliver to. */
  endpoints: Endpoint[];
  /** The event name (e.g. "order.completed"). */
  event: string;
  /** The event payload data. */
  data: unknown;
  /** Callback called with each delivery result and endpoint. */
  onDelivery?: (result: DeliveryResult, endpoint: Endpoint) => void | Promise<void>;
  /** Per-endpoint timeout in ms (default 10000). */
  timeout?: number;
  /** Prefix for signature headers (default "X-Webhook"). */
  headerPrefix?: string;
}

export interface VerifyOptions {
  /** The raw request body string. */
  body: string;
  /** The signature header value (e.g. "sha256=a1b2c3..."). */
  signature: string;
  /** The timestamp header value (unix seconds as string). */
  timestamp: string;
  /** The shared signing secret. */
  secret: string;
  /** Max age in seconds before rejecting (default 300). Set to 0 to disable. */
  tolerance?: number;
}

export interface VerifyResult {
  /** Whether the signature is valid. */
  valid: boolean;
  /** Reason for failure, if invalid. */
  reason?: string;
}

/** Sign a payload with HMAC-SHA256. Returns "sha256=<hex>". */
export function signPayload(secret: string, timestamp: number, body: string): Promise<string>;

/** Deliver a webhook to a single endpoint. Never throws. */
export function deliverToEndpoint(endpoint: Endpoint, eventName: string, bodyStr: string, options?: DeliveryOptions): Promise<DeliveryResult>;

/** Verify an incoming webhook payload signature. Checks HMAC and replay tolerance. */
export function verifyPayload(options: VerifyOptions): Promise<VerifyResult>;

/** Dispatch a webhook event to multiple endpoints concurrently. Never throws. */
export function dispatch(options: DispatchOptions): Promise<DeliveryResult[]>;
