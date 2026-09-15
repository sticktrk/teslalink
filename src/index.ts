import { Records } from './records';
import { DurableObject } from 'cloudflare:workers';
import { HttpError, equalSecret, hash, integer, originUrl, randomToken, readJson, retrySeconds, seal, unseal, validVin } from './security';
import { API_HOSTS, SCOPES, TOKEN_URL, buildFields, catalog, validateEvents, validateFields } from './telemetry';

export interface Env {
  GARAGE: DurableObjectNamespace<Garage>;
  HISTORY_DB?: D1Database;
  ASSETS: Fetcher;
  APP_URL: string;
  APP_PASSWORD?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  TESLA_CLIENT_ID?: string;
  TESLA_CLIENT_SECRET?: string;
  TESLA_PUBLIC_KEY?: string;
  TESLA_REGION?: string;
  RETENTION_DAYS?: string;
  SNAPSHOT_COOLDOWN_SECONDS?: string;
  SNAPSHOT_DAILY_LIMIT?: string;
  INGEST_TOKEN?: string;
  TELEMETRY_HOST?: string;
  TELEMETRY_PORT?: string;
  TELEMETRY_CA?: string;
  TELEMETRY_PROXY_URL?: string;
  TELEMETRY_PROXY_TOKEN?: string;
}

type TokenSet = { access_token: string; refresh_token: string; expires_at: number; scope: string };
type VehicleRow = { vin: string; name: string; state: string; data: string; active: number; updated_at: number; config: string | null; config_expires: number | null };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) => Response.json(data, { status, headers });
const pem = (value?: string) => value?.replaceAll('\\n', '\n').trim() + '\n';
const now = () => Date.now();

function safeResponse(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/appspecific/com.tesla.3p.public-key.pem' && ['GET', 'HEAD'].includes(request.method)) {
        if (!env.TESLA_PUBLIC_KEY?.includes('BEGIN PUBLIC KEY')) return safeResponse(new Response('Public key not configured', { status: 404 }));
        const bytes = new TextEncoder().encode(pem(env.TESLA_PUBLIC_KEY));
        const headers = new Headers({ 'Content-Type': 'application/x-pem-file', 'Accept-Ranges': 'bytes' });
        const range = request.headers.get('range');
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          const start = match ? Number(match[1]) : -1;
          const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
          if (start < 0 || start >= bytes.length || end < start) return safeResponse(new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } }));
          headers.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
          headers.set('Content-Length', String(end - start + 1));
          return safeResponse(new Response(request.method === 'HEAD' ? null : bytes.slice(start, end + 1), { status: 206, headers }));
        }
        headers.set('Content-Length', String(bytes.length));
        return safeResponse(new Response(request.method === 'HEAD' ? null : bytes, { headers }));
      }
      if (path === '/healthz') return safeResponse(json({ ok: true, app: 'tesla-link' }));
      if (path.startsWith('/api/') || path.startsWith('/auth/')) {
        const app = originUrl(env.APP_URL);
        if (new URL(request.url).origin !== app.origin) throw new HttpError(503, 'APP_URL does not match this deployment. Update APP_URL in the deployment configuration.');
        return safeResponse(await env.GARAGE.get(env.GARAGE.idFromName('owner')).fetch(request));
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
      return safeResponse(await env.ASSETS.fetch(request));
    } catch (error) {
      return safeResponse(errorResponse(error));
    }
  },
} satisfies ExportedHandler<Env>;

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) }, error.status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
  // Never log upstream bodies, OAuth codes, tokens, VINs, or location data.
  console.error('Tesla Link request failed:', error instanceof Error ? error.name : 'UnknownError');
  return json({ error: 'The request could not be completed. Check the app configuration and try again.' }, 500);
}

export class Garage extends DurableObject<Env> {
  private sql: SqlStorage;
  private records: Records;
  private externalQueue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.records = new Records(this.sql, fn => ctx.storage.transactionSync(fn), env.HISTORY_DB);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth (state TEXT PRIMARY KEY, session TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vehicles (vin TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, config TEXT, config_expires INTEGER);
      CREATE TABLE IF NOT EXISTS signals (vin TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, timestamp INTEGER NOT NULL, timestamp_source TEXT NOT NULL, PRIMARY KEY(vin, field));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, vin TEXT NOT NULL, kind TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, timestamp INTEGER NOT NULL, timestamp_source TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_vin_seq ON events(vin, seq);
      CREATE INDEX IF NOT EXISTS events_vin_field_time ON events(vin, field, timestamp);
      CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, vin TEXT NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_vin_time ON snapshots(vin, timestamp);
      CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, category TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day, category));
      CREATE TABLE IF NOT EXISTS throttles (key TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
    `);
    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(events)').toArray().some(column => column.name === 'numeric_value')) this.sql.exec('ALTER TABLE events ADD COLUMN numeric_value REAL');
  }

  private get<T>(key: string, fallback: T): T {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) as T : fallback;
  }
  private set(key: string, value: unknown) { this.sql.exec('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
  private count(category: string, amount = 1) {
    this.sql.exec('INSERT INTO usage(day,category,count) VALUES(?,?,?) ON CONFLICT(day,category) DO UPDATE SET count=count+excluded.count', new Date().toISOString().slice(0, 10), category, amount);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.externalQueue.then(fn, fn);
    this.externalQueue = run.catch(() => {});
    return run;
  }
  private throttle(key: string, seconds: number) {
    const row = this.sql.exec<{ next_at: number }>('SELECT next_at FROM throttles WHERE key=?', key).toArray()[0];
    if (row && row.next_at > now()) throw new HttpError(429, 'Please wait before trying this action again.', Math.ceil((row.next_at - now()) / 1000));
    this.sql.exec('INSERT INTO throttles(key,next_at) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET next_at=excluded.next_at', key, now() + seconds * 1000);
  }
  private cookie(value: string, maxAge = 604800) {
    const secure = originUrl(this.env.APP_URL).protocol === 'https:';
    return `tl_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  private async session(request: Request): Promise<string | null> {
    const raw = /(?:^|;\s*)tl_session=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1];
    if (!raw || raw.length > 128 || !this.env.APP_PASSWORD || this.env.APP_PASSWORD.length < 24) return null;
    const id = await hash(raw);
    const row = this.sql.exec<{ expires: number; password_hash: string }>('SELECT expires,password_hash FROM sessions WHERE id=?', id).toArray()[0];
    return row && row.expires > now() && await equalSecret(row.password_hash, await hash(this.env.APP_PASSWORD)) ? id : null;
  }
  private requireOrigin(request: Request) {
    if (request.headers.get('origin') !== originUrl(this.env.APP_URL).origin) throw new HttpError(403, 'This action must be initiated from the app.');
  }
  private missing(keys: (keyof Env)[]) { return keys.filter(key => !this.env[key]); }
  private ready() {
    const missing = this.missing(['TESLA_CLIENT_ID', 'TESLA_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY']);
    if (missing.length) throw new HttpError(503, `Configure ${missing.join(', ')} first.`);
    if (!API_HOSTS[this.env.TESLA_REGION || 'na']) throw new HttpError(503, 'TESLA_REGION must be na or eu.');
  }
  private base() { this.ready(); return API_HOSTS[this.env.TESLA_REGION || 'na']; }
  private vehicle(vin: string): VehicleRow {
    if (!validVin(vin)) throw new HttpError(400, 'Invalid VIN.');
    const vehicle = this.sql.exec<VehicleRow>('SELECT * FROM vehicles WHERE vin=? AND active=1', vin).toArray()[0];
    if (!vehicle) throw new HttpError(404, 'Vehicle not found. Refresh your vehicles first.');
    return vehicle;
  }

  async fetch(request: Request): Promise<Response> {
    try { return await this.route(request); } catch (error) { return errorResponse(error); }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (path === '/api/ingest' && method === 'POST') return this.ingest(request);
    if (path === '/api/receiver/vehicles' && method === 'GET') {
      if (!this.env.INGEST_TOKEN || this.env.INGEST_TOKEN.length < 32 || !await equalSecret(request.headers.get('authorization') || '', `Bearer ${this.env.INGEST_TOKEN}`)) throw new HttpError(401, 'Invalid ingestion credentials.');
      return json({ vins: this.get('connected', false) ? this.sql.exec<{vin:string}>('SELECT vin FROM vehicles WHERE active=1').toArray().map(v=>v.vin) : [] });
    }
    const session = await this.session(request);
    if (path === '/api/session' && method === 'GET') return json({ authenticated: !!session, configured: !!this.env.APP_PASSWORD && this.env.APP_PASSWORD.length >= 24 });
    if (path === '/auth/login' && method === 'POST') {
      this.requireOrigin(request);
      if (!this.env.APP_PASSWORD || this.env.APP_PASSWORD.length < 24) throw new HttpError(503, 'Set APP_PASSWORD to at least 24 random characters before signing in.');
      const body = await readJson(request, 4096);
      this.throttle('login-global', 1);
      this.throttle(`login:${await hash(request.headers.get('cf-connecting-ip') || 'local')}`, 3);
      const failures = this.get('login-failures', { count: 0, reset: 0 });
      if (failures.reset > now() && failures.count >= 20) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.', Math.ceil((failures.reset - now()) / 1000));
      if (typeof body?.password !== 'string' || !await equalSecret(body.password, this.env.APP_PASSWORD)) {
        this.set('login-failures', { count: failures.reset > now() ? failures.count + 1 : 1, reset: failures.reset > now() ? failures.reset : now() + 900000 });
        throw new HttpError(401, 'Incorrect app password.');
      }
      this.set('login-failures', { count: 0, reset: 0 });
      const raw = randomToken();
      this.sql.exec('DELETE FROM sessions WHERE expires < ?', now());
      this.sql.exec('INSERT INTO sessions VALUES(?,?,?)', await hash(raw), now() + 604800000, await hash(this.env.APP_PASSWORD));
      await this.ensureAlarm();
      return json({ ok: true }, 200, { 'Set-Cookie': this.cookie(raw) });
    }
    if (!session) throw new HttpError(401, 'Sign in to Tesla Link first.');
    if (!['GET', 'HEAD'].includes(method)) this.requireOrigin(request);
    if (path === '/auth/logout' && method === 'POST') {
      this.sql.exec('DELETE FROM sessions WHERE id=?', session);
      return json({ ok: true }, 200, { 'Set-Cookie': this.cookie('', 0) });
    }
    if (path === '/api/status' && method === 'GET') return json(this.status());
    if (path === '/api/catalog' && method === 'GET') return json({ fields: catalog, presets: Object.fromEntries(['essentials', 'complete', 'high-detail'].map(name => [name, buildFields(name)])) });
    if (path === '/api/connect' && method === 'POST') {
      this.ready();
      this.throttle('connect', 5);
      const state = randomToken();
      this.sql.exec('DELETE FROM oauth WHERE expires < ? OR session = ?', now(), session);
      this.sql.exec('INSERT INTO oauth VALUES(?,?,?)', await hash(state), session, now() + 600000);
      const authorize = new URL('https://auth.tesla.com/oauth2/v3/authorize');
      await seal({}, this.env.TOKEN_ENCRYPTION_KEY!);
      authorize.search = new URLSearchParams({ client_id: this.env.TESLA_CLIENT_ID!, redirect_uri: `${originUrl(this.env.APP_URL).origin}/auth/callback`, response_type: 'code', scope: SCOPES, state, prompt_missing_scopes: 'true', require_requested_scopes: 'true' }).toString();
      return json({ url: authorize.href });
    }
    if (path === '/auth/callback' && method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const row = this.sql.exec<{ session: string; expires: number }>('DELETE FROM oauth WHERE state=? RETURNING session,expires', await hash(state)).toArray()[0];
      if (!row || row.session !== session || row.expires < now()) throw new HttpError(400, 'Tesla sign-in expired or did not match this session. Start again from the app.');
      if (url.searchParams.has('error')) return Response.redirect(`${originUrl(this.env.APP_URL).origin}/?connection=cancelled`, 303);
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) throw new HttpError(400, 'Missing Tesla authorization code.');
      return this.serial(async () => {
        await this.exchange({ grant_type: 'authorization_code', code, client_secret: this.env.TESLA_CLIENT_SECRET!, audience: this.base(), redirect_uri: `${originUrl(this.env.APP_URL).origin}/auth/callback` });
        // Discovery remains a separate retryable action if Fleet API setup is incomplete.
        this.set('connected', true);
        this.set('auth-error', null);
        await this.ensureAlarm();
        return Response.redirect(`${originUrl(this.env.APP_URL).origin}/?connection=success`, 303);
      });
    }
    if (path === '/api/register' && method === 'POST') return this.serial(async () => {
      this.ready(); this.throttle('register', 60);
      if (!this.env.TESLA_PUBLIC_KEY?.includes('BEGIN PUBLIC KEY')) throw new HttpError(503, 'Configure TESLA_PUBLIC_KEY first.');
      const response = await this.upstream(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.env.TESLA_CLIENT_ID!, client_secret: this.env.TESLA_CLIENT_SECRET!, audience: this.base(), scope: 'vehicle_device_data vehicle_location' }) }, 'auth');
      if (typeof response.access_token !== 'string') throw new HttpError(502, 'Tesla did not return a partner token.');
      const result = await this.upstream(`${this.base()}/api/1/partner_accounts`, { method: 'POST', headers: { Authorization: `Bearer ${response.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: originUrl(this.env.APP_URL).hostname }) }, 'fleet');
      this.set(`registered:${this.env.TESLA_REGION || 'na'}`, now());
      return json({ ok: true, result });
    });
    if (path === '/api/vehicles/refresh' && method === 'POST') return this.serial(async () => {
      this.throttle('discovery', 60);
      const all: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const result = await this.tesla(`/api/1/vehicles?page=${page}&per_page=100`);
        if (!Array.isArray(result.response)) throw new HttpError(502, 'Unexpected vehicle list from Tesla.');
        all.push(...result.response);
        if (result.response.length < 100) break;
        if (page === 10) throw new HttpError(400, 'This personal app supports up to 1,000 vehicles.');
      }
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('UPDATE vehicles SET active=0');
        for (const v of all) if (validVin(v.vin)) this.sql.exec('INSERT INTO vehicles(vin,name,state,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(vin) DO UPDATE SET name=excluded.name,state=excluded.state,data=excluded.data,active=1,updated_at=excluded.updated_at', v.vin, v.display_name || 'My Tesla', v.state || 'unknown', JSON.stringify(v), now());
      });
      return json({ count: all.length });
    });
    const match = /^\/api\/vehicles\/([A-HJ-NPR-Z0-9]{17})(?:\/(snapshot|telemetry|diagnostics|history|export|series))?$/.exec(path);
    if (match) {
      const vin = match[1], action = match[2];
      const vehicle = this.vehicle(vin);
      if (!action && method === 'GET') return json(await this.vehicleData(vehicle));
      if (action === 'snapshot' && method === 'POST') return this.serial(() => this.snapshot(vin));
      if (action === 'diagnostics' && method === 'POST') return this.serial(async () => {
        this.throttle(`diagnostics:${vin}`, 60);
        const result: Record<string, unknown> = {};
        for (const [key, endpoint, options] of [
          ['fleet', '/api/1/vehicles/fleet_status', { method: 'POST', body: JSON.stringify({ vins: [vin] }) }],
          ['config', `/api/1/vehicles/${vin}/fleet_telemetry_config`, {}],
          ['errors', `/api/1/vehicles/${vin}/fleet_telemetry_errors`, {}],
        ] as const) {
          try { result[key] = await this.tesla(endpoint, options); }
          catch (error) { result[key] = { error: error instanceof HttpError ? error.message : 'Request failed' }; }
        }
        this.set(`diagnostics:${vin}`, { timestamp: now(), result });
        return json(result);
      });
      if (action === 'telemetry' && method === 'POST') {
        const body = await readJson(request);
        const fields = body.fields ? validateFields(body.fields) : buildFields(body.preset || 'complete', body.location !== false);
        return this.serial(async () => {
          this.throttle(`config:${vin}`, 60);
          const status = await this.tesla('/api/1/vehicles/fleet_status', { method: 'POST', body: JSON.stringify({ vins: [vin] }) });
          const info = status.response?.vehicle_info?.[vin];
          const legacyStreamingEnabled = info?.vehicle_command_protocol_required === false && info?.safety_screen_streaming_toggle_enabled === true && !!info?.fleet_telemetry_version;
          if (!status.response?.key_paired_vins?.includes(vin) && !legacyStreamingEnabled) throw new HttpError(409, 'Pair the app key first. On supported older Model S/X vehicles, enable Allow Third-Party App Data Streaming in the car’s Safety settings instead. Then check diagnostics.');
          const expires = Math.floor(now() / 1000) + 30 * 86400;
          const result = await this.configure(vin, fields, expires);
          this.sql.exec('UPDATE vehicles SET config=?,config_expires=? WHERE vin=?', JSON.stringify(fields), expires, vin);
          this.set(`renewal:${vin}`, null);
          await this.ensureAlarm();
          return json({ ok: true, result, expires });
        });
      }
      if (action === 'telemetry' && method === 'DELETE') return this.serial(async () => {
        this.throttle(`stop:${vin}`, 10);
        const result = await this.tesla(`/api/1/vehicles/${vin}/fleet_telemetry_config`, { method: 'DELETE' });
        this.sql.exec('UPDATE vehicles SET config=NULL,config_expires=NULL WHERE vin=?', vin);
        return json({ ok: true, result });
      });
      if (action === 'history' && method === 'GET') return json(await this.history(vin, url));
      if (action === 'export' && method === 'GET') {
        if (url.searchParams.get('all') === '1') return this.exportAll(vin);
        const page = await this.history(vin, url);
        return new Response(page.events.map(event => JSON.stringify(event)).join('\n') + (page.events.length ? '\n' : ''), { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="tesla-${vin}-${page.nextCursor || 'end'}.ndjson"`, 'X-Next-Cursor': page.nextCursor || '' } });
      }
      if (action === 'series' && method === 'GET') {
        const field = url.searchParams.get('field') || 'Soc';
        const hours = integer(url.searchParams.get('hours'), 24, 1, 168);
        const points = (await this.records.query<{ timestamp: number; value: number }>(`SELECT CAST(timestamp / 300000 AS INTEGER) * 300000 AS timestamp, AVG(numeric_value) AS value FROM events WHERE vin=? AND kind='signal' AND field=? AND timestamp>=? AND numeric_value IS NOT NULL GROUP BY CAST(timestamp / 300000 AS INTEGER) ORDER BY timestamp LIMIT 2016`, vin, field, now() - hours * 3600000));
        return json({ field, points });
      }
    }
    throw new HttpError(404, 'Endpoint not found.');
  }

  private status() {
    return {
      connected: this.get('connected', false), authError: this.get('auth-error', null),
      historyStorage: this.env.HISTORY_DB ? 'Cloudflare D1' : 'SQLite', region: this.env.TESLA_REGION || 'na', registeredAt: this.get(`registered:${this.env.TESLA_REGION || 'na'}`, null),
      missing: this.missing(['TESLA_CLIENT_ID', 'TESLA_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'TESLA_PUBLIC_KEY']),
      streamingMissing: this.missing(['INGEST_TOKEN', 'TELEMETRY_HOST', 'TELEMETRY_CA', 'TELEMETRY_PROXY_URL', 'TELEMETRY_PROXY_TOKEN']),
      vehicles: this.sql.exec<VehicleRow>('SELECT * FROM vehicles WHERE active=1 ORDER BY name').toArray().map(v => ({ vin: v.vin, name: v.name, state: v.state, updatedAt: v.updated_at, collecting: !!v.config, configExpires: v.config_expires, renewal: this.get(`renewal:${v.vin}`, null) })),
      pairingUrl: `https://www.tesla.com/_ak/${originUrl(this.env.APP_URL).hostname}`,
      revokeUrl: `https://auth.tesla.com/user/revoke/consent?${new URLSearchParams({ revoke_client_id: this.env.TESLA_CLIENT_ID || '', back_url: originUrl(this.env.APP_URL).origin })}`,
      retentionDays: integer(this.env.RETENTION_DAYS, 30, 1, 365),
      usage: this.sql.exec('SELECT category,SUM(count) AS count FROM usage WHERE day>=? GROUP BY category', new Date().toISOString().slice(0, 7) + '-01').toArray(),
      lastIngestAt: this.get('last-ingest', null), storageBytes: this.sql.databaseSize,
      limits: { snapshotCooldown: integer(this.env.SNAPSHOT_COOLDOWN_SECONDS, 900, 60, 86400), snapshotDailyLimit: integer(this.env.SNAPSHOT_DAILY_LIMIT, 24, 1, 100) },
      backoffUntil: this.get('backoff:fleet', 0), fieldCount: Object.keys(buildFields('complete')).length,
    };
  }

  private async vehicleData(vehicle: VehicleRow) {
    const signals = (await this.records.query<{ field: string; value: string; timestamp: number; timestamp_source: string }>('SELECT field,value,timestamp,timestamp_source FROM signals WHERE vin=? ORDER BY field', vehicle.vin)).map(s => ({ ...s, value: JSON.parse(s.value) }));
    const snapshot = (await this.records.query<{ timestamp: number; data: string }>('SELECT timestamp,data FROM snapshots WHERE vin=? ORDER BY timestamp DESC LIMIT 1', vehicle.vin))[0];
    return { vehicle: { ...vehicle, data: JSON.parse(vehicle.data), config: vehicle.config ? JSON.parse(vehicle.config) : null }, signals, snapshot: snapshot ? { timestamp: snapshot.timestamp, data: JSON.parse(snapshot.data) } : null, diagnostics: this.get(`diagnostics:${vehicle.vin}`, null) };
  }

  private async history(vin: string, url: URL) {
    const cursor = integer(url.searchParams.get('cursor'), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(url.searchParams.get('limit'), 1000, 1, 2000);
    const rows = (await this.records.query<{ seq: number; id: string; vin: string; kind: string; field: string; value: string; timestamp: number; timestamp_source: string; received_at: number }>('SELECT * FROM events WHERE vin=? AND seq>? ORDER BY seq LIMIT ?', vin, cursor, limit + 1));
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(row => ({ ...row, value: JSON.parse(row.value) }));
    return { events, nextCursor: hasMore ? String(events.at(-1)!.seq) : null };
  }

  private async exportAll(vin: string): Promise<Response> {
    // Stable high-water mark; read a bounded page on demand rather than loading history into memory.
    const high = (await this.records.query<{ seq: number }>('SELECT MAX(seq) AS seq FROM events WHERE vin=?', vin))[0]?.seq || 0;
    let cursor = 0;
    const records = this.records;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const rows = (await records.query<{ seq: number; value: string }>('SELECT * FROM events WHERE vin=? AND seq>? AND seq<=? ORDER BY seq LIMIT 250', vin, cursor, high));
        if (!rows.length) { controller.close(); return; }
        cursor = rows.at(-1)!.seq;
        controller.enqueue(new TextEncoder().encode(rows.map(row => JSON.stringify({ ...row, value: JSON.parse(row.value) })).join('\n') + '\n'));
        if (cursor >= high) controller.close();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="tesla-${vin}-${new Date().toISOString().slice(0, 10)}.ndjson"` } });
  }

  private async ingest(request: Request) {
    if (!this.env.INGEST_TOKEN || this.env.INGEST_TOKEN.length < 32 || !await equalSecret(request.headers.get('authorization') || '', `Bearer ${this.env.INGEST_TOKEN}`)) throw new HttpError(401, 'Invalid ingestion credentials.');
    const events = validateEvents(await readJson(request));
    if (!this.get('connected', false)) throw new HttpError(409, 'Connect a Tesla account before sending telemetry.');
    const allowed = new Set(this.sql.exec<{ vin: string }>('SELECT vin FROM vehicles WHERE active=1').toArray().map(v => v.vin));
    if (events.some(e => !allowed.has(e.vin))) throw new HttpError(403, 'Telemetry includes a vehicle not linked to this app. Refresh vehicles in the app.');
    const accepted = await this.records.ingest(events, now());
    this.count('received_events', accepted);
    this.set('last-ingest', now());
    await this.ensureAlarm();
    return json({ accepted, duplicates: events.length - accepted });
  }

  private async exchange(values: Record<string, string>): Promise<TokenSet> {
    this.ready();
    const result = await this.upstream(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.env.TESLA_CLIENT_ID!, ...values }) }, 'auth');
    if (typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new HttpError(502, 'Tesla returned an incomplete token response.');
    const token: TokenSet = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: now() + result.expires_in * 1000, scope: result.scope || SCOPES };
    this.set('tokens', await seal(token, this.env.TOKEN_ENCRYPTION_KEY!));
    this.set('token-expires', token.expires_at);
    return token;
  }

  private async token(forceRefresh = false): Promise<string> {
    this.ready();
    const encrypted = this.get<string | null>('tokens', null);
    if (!encrypted || !this.get('connected', false)) throw new HttpError(401, 'Connect your Tesla account.');
    let token = await unseal<TokenSet>(encrypted, this.env.TOKEN_ENCRYPTION_KEY!);
    if (forceRefresh || token.expires_at < now() + 120000) {
      try { token = await this.exchange({ grant_type: 'refresh_token', refresh_token: token.refresh_token }); }
      catch (error) {
        if (error instanceof HttpError && [400, 401, 403].includes(error.status)) {
          this.set('connected', false);
          this.set('auth-error', 'Tesla access expired or was revoked. Reconnect your account.');
        }
        throw error;
      }
    }
    return token.access_token;
  }

  private async upstream(url: string, init: RequestInit, category: 'auth' | 'fleet' | 'snapshot' | 'proxy'): Promise<any> {
    const bucket = category === 'auth' ? 'auth' : 'fleet';
    const until = this.get(`backoff:${bucket}`, 0);
    if (until > now()) throw new HttpError(429, 'Tesla requests are paused after a rate limit or temporary failure.', Math.ceil((until - now()) / 1000));
    let response: Response;
    this.count(`${category}_requests`);
    try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
    catch { this.set(`backoff:${bucket}`, now() + 60000); throw new HttpError(502, 'Tesla or the receiver could not be reached. Requests are paused for one minute.'); }
    if (response.status === 429 || response.status >= 500) {
      const seconds = retrySeconds(response.headers);
      this.set(`backoff:${bucket}`, now() + seconds * 1000);
      throw new HttpError(response.status === 429 ? 429 : 502, 'Tesla or the receiver is temporarily limiting requests.', seconds);
    }
    // Never echo token responses or arbitrary upstream error bodies.
    let body: any;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: 'Tesla rejected the request. Check application registration, scopes, field names, and receiver settings.',
        401: 'Tesla authorization failed. Reconnect your Tesla account if this persists.',
        402: 'Tesla billing is not enabled or the billing limit was reached. Check the Tesla developer dashboard.',
        403: 'Tesla denied access. Check granted permissions, regional registration, and billing in the Tesla developer dashboard.',
        404: 'Tesla could not find this vehicle or configuration.',
        408: 'The vehicle is asleep or unavailable. This app will not wake it.',
        412: 'Tesla requires additional vehicle setup. Check key pairing and diagnostics.',
      };
      throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, messages[response.status] || `Tesla request failed (${response.status}).`);
    }
    return body || {};
  }

  private async tesla(path: string, init: RequestInit = {}, category: 'fleet' | 'snapshot' = 'fleet') {
    const call = async (token: string) => this.upstream(`${this.base()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, category);
    try { return await call(await this.token()); }
    catch (error) {
      if (error instanceof HttpError && error.status === 401 && this.get('connected', false)) return call(await this.token(true));
      throw error;
    }
  }

  private async snapshot(vin: string): Promise<Response> {
    this.throttle(`snapshot:${vin}`, integer(this.env.SNAPSHOT_COOLDOWN_SECONDS, 900, 60, 86400));
    const day = new Date().toISOString().slice(0, 10);
    const used = this.get(`snapshots:${vin}`, { day, count: 0 });
    if (used.day === day && used.count >= integer(this.env.SNAPSHOT_DAILY_LIMIT, 24, 1, 100)) throw new HttpError(429, 'Daily snapshot limit reached. Use streaming for ongoing collection.', 3600);
    const state = await this.tesla(`/api/1/vehicles/${vin}`);
    const online = state.response?.state;
    this.sql.exec('UPDATE vehicles SET state=?,updated_at=? WHERE vin=?', online || 'unknown', now(), vin);
    if (online !== 'online') throw new HttpError(409, 'The vehicle is asleep or offline. Try again when it is awake; no wake request was sent.');
    this.set(`snapshots:${vin}`, { day, count: used.day === day ? used.count + 1 : 1 });
    const endpoints = 'charge_state;climate_state;closures_state;drive_state;gui_settings;location_data;vehicle_config;vehicle_state';
    const result = await this.tesla(`/api/1/vehicles/${vin}/vehicle_data?endpoints=${encodeURIComponent(endpoints)}`, {}, 'snapshot');
    if (!result.response || typeof result.response !== 'object') throw new HttpError(502, 'Tesla returned no vehicle data.');
    const timestamp = now();
    await this.records.batch([
      {sql:'INSERT INTO snapshots(vin,timestamp,data) VALUES(?,?,?)',params:[vin,timestamp,JSON.stringify(result.response)]},
      {sql:'INSERT INTO events(id,vin,kind,field,value,timestamp,timestamp_source,received_at) VALUES(?,?,?,?,?,?,?,?)',params:[randomToken(),vin,'snapshot','vehicle_data',JSON.stringify(result.response),timestamp,'receiver',timestamp]},
    ]);
    return json({ timestamp, data: result.response });
  }

  private async configure(vin: string, fields: unknown, expiration: number) {
    const missing = this.missing(['INGEST_TOKEN', 'TELEMETRY_HOST', 'TELEMETRY_CA', 'TELEMETRY_PROXY_URL', 'TELEMETRY_PROXY_TOKEN']);
    if (missing.length) throw new HttpError(503, `Configure ${missing.join(', ')} to enable streaming.`);
    if (this.env.INGEST_TOKEN!.length < 32 || this.env.TELEMETRY_PROXY_TOKEN!.length < 32) throw new HttpError(503, 'Receiver tokens must each contain at least 32 random characters.');
    const proxy = new URL(this.env.TELEMETRY_PROXY_URL!);
    if (proxy.protocol !== 'https:' || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new HttpError(503, 'TELEMETRY_PROXY_URL must be an HTTPS origin.');
    const host = this.env.TELEMETRY_HOST!;
    if (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])$/.test(host) || !host.includes('.')) throw new HttpError(503, 'TELEMETRY_HOST must be a public DNS hostname.');
    const body = { vins: [vin], config: { hostname: host, port: integer(this.env.TELEMETRY_PORT, 443, 1, 65535), ca: pem(this.env.TELEMETRY_CA), expiration, fields } };
    const result = await this.upstream(`${proxy.origin}/configure`, { method: 'POST', headers: { Authorization: `Bearer ${await this.token()}`, 'X-Proxy-Token': this.env.TELEMETRY_PROXY_TOKEN!, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'proxy');
    const response = result.response;
    if (!response || Number(response.updated_vehicles) !== 1 || Object.values(response.skipped_vehicles || {}).some(values => Array.isArray(values) ? values.length > 0 : !!values)) {
      throw new HttpError(409, `Tesla did not configure this vehicle. Check diagnostics for key, firmware, hardware, or configuration limits. Skipped reasons: ${Object.keys(response?.skipped_vehicles || {}).filter(key => /^[a-z_]+$/.test(key)).join(', ') || 'unknown'}.`);
    }
    return result;
  }

  private async ensureAlarm() {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(now() + 3600000);
  }

  async alarm() {
    try {
      const cutoff = now() - integer(this.env.RETENTION_DAYS, 30, 1, 365) * 86400000;
      await this.records.query('DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE received_at<? LIMIT 10000)', cutoff);
      await this.records.query('DELETE FROM snapshots WHERE timestamp<?', cutoff);
      this.sql.exec('DELETE FROM sessions WHERE expires<?', now());
      this.sql.exec('DELETE FROM oauth WHERE expires<?', now());
      this.sql.exec('DELETE FROM throttles WHERE next_at<?', now());
      this.sql.exec('DELETE FROM usage WHERE day<?', new Date(now() - 400 * 86400000).toISOString().slice(0, 10));
      if (this.get('connected', false)) await this.serial(async () => {
        await this.token();
        // Renew only an existing Tesla config. A removed/billing-suspended config requires an explicit user action.
        const expiring = this.sql.exec<VehicleRow>('SELECT * FROM vehicles WHERE active=1 AND config IS NOT NULL AND config_expires<?', Math.floor(now() / 1000) + 7 * 86400).toArray();
        for (const vehicle of expiring) {
          if (this.get<number>(`renew-check:${vehicle.vin}`, 0) > now() - 86400000) continue;
          this.set(`renew-check:${vehicle.vin}`, now());
          try {
            const remote = await this.tesla(`/api/1/vehicles/${vehicle.vin}/fleet_telemetry_config`);
            if (!remote.response?.config?.hostname || remote.response.config.hostname !== this.env.TELEMETRY_HOST) {
              this.set(`renewal:${vehicle.vin}`, 'Streaming configuration is missing or changed at Tesla. Check billing and re-enable it manually.');
              continue;
            }
            const expiration = Math.floor(now() / 1000) + 30 * 86400;
            await this.configure(vehicle.vin, JSON.parse(vehicle.config!), expiration);
            this.sql.exec('UPDATE vehicles SET config_expires=? WHERE vin=?', expiration, vehicle.vin);
            this.set(`renewal:${vehicle.vin}`, null);
          } catch (error) { this.set(`renewal:${vehicle.vin}`, error instanceof HttpError ? error.message : 'Automatic renewal failed. Check receiver configuration.'); }
        }
      });
    } catch (error) { console.error('Tesla Link maintenance failed:', error instanceof Error ? error.name : 'UnknownError'); }
    finally {
      const cutoff = now() - integer(this.env.RETENTION_DAYS, 30, 1, 365) * 86400000;
      let delay = 60000;
      try {
        const remaining = (await this.records.query('SELECT seq FROM events WHERE received_at<? LIMIT 1', cutoff)).length;
        delay = remaining ? 60000 : 3600000;
      } finally { await this.ctx.storage.setAlarm(now() + delay); }
    }
  }
}
