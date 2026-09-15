export class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) { super(message); }
}

export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function randomToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function hash(value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export async function equalSecret(a: string, b: string): Promise<boolean> {
  const aa = await hash(a), bb = await hash(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return diff === 0;
}

function encryptionKey(encoded: string) {
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); } catch { throw new HttpError(503, 'TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64.'); }
  if (bytes.length !== 32) throw new HttpError(503, 'TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(value: unknown, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('tesla-link:oauth:v1') }, await encryptionKey(key), new TextEncoder().encode(JSON.stringify(value)));
  return `v1.${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}

export async function unseal<T>(value: string, key: string): Promise<T> {
  const [version, iv, data] = value.split('.');
  if (version !== 'v1') throw new Error('Invalid encrypted token version');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)), additionalData: new TextEncoder().encode('tesla-link:oauth:v1') }, await encryptionKey(key), Uint8Array.from(atob(data), c => c.charCodeAt(0)));
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export async function readJson(request: Request, maxBytes = 262144): Promise<any> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send application/json.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON body is required.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(body)); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export function retrySeconds(headers: Headers, now = Date.now()): number {
  const retry = headers.get('retry-after');
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds)) return Math.max(1, Math.min(86400, Math.ceil(seconds)));
    const date = Date.parse(retry);
    if (Number.isFinite(date)) return Math.max(1, Math.min(86400, Math.ceil((date - now) / 1000)));
  }
  let reset = 0;
  for (const [key, value] of headers) {
    if (/^ratelimit-.*-reset$/i.test(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) reset = Math.max(reset, n > 1e9 ? n - now / 1000 : n);
    }
  }
  return Math.max(60, Math.min(86400, Math.ceil(reset)));
}

export function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export function validVin(value: unknown): value is string {
  return typeof value === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(value);
}

export function originUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(503, 'Set APP_URL to the public app origin.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new HttpError(503, 'APP_URL must be an HTTPS origin (HTTP is allowed for localhost).');
  return url;
}
