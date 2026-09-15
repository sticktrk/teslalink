import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Response as MFResponse, convertV4MiniflareOptions } from 'miniflare';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const origin = 'https://garage.example.com';
const vin = '5YJ3E1EA7KF000001';
const password = 'test-only-private-password-at-least-24-characters';
const ingest = 'test-only-ingestion-secret-12345678901234567890';
let script = '';
const instances: Miniflare[] = [];
before(async () => { script = (await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], write: false })).outputFiles[0].text; });
after(async () => { await Promise.all(instances.map(m => m.dispose())); });

async function fixture(options: { online?: boolean; rateLimit?: boolean; skipped?: boolean; tokenExpiry?: number; redirectToken?: boolean; legacy?: boolean; d1?: boolean; authRelay?: boolean; authEdge?: boolean } = {}) {
  const calls: { path: string; method: string; body: any; authorization: string | null }[] = [];
  let refreshes = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'test', modules: true, script, compatibilityDate: '2026-09-01',
    durableObjects: { GARAGE: { className: 'Garage', useSQLite: true } },
    ...(options.d1 ? { d1Databases: ['HISTORY_DB'] } : {}),
    bindings: { ...(options.authRelay?{TESLA_AUTH_RELAY_URL:'https://auth-relay.example/oauth/token',TESLA_AUTH_RELAY_TOKEN:'test-relay-secret-12345678901234567890'}:{}), APP_URL: origin, APP_PASSWORD: password, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), TESLA_CLIENT_ID: 'test-client', TESLA_CLIENT_SECRET: 'test-secret', TESLA_REGION: 'na', TESLA_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nTEST PUBLIC KEY\n-----END PUBLIC KEY-----', INGEST_TOKEN: ingest, TELEMETRY_HOST: 'receiver.example.com', TELEMETRY_CA: '-----BEGIN CERTIFICATE-----\nTEST CA\n-----END CERTIFICATE-----', TELEMETRY_PROXY_URL: 'https://receiver.example.com:8443', TELEMETRY_PROXY_TOKEN: 'test-only-proxy-secret-12345678901234567890' },
    outboundService: async request => {
      const url = new URL(request.url), raw = await request.text();
      const body = raw ? request.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) : null;
      calls.push({ path: url.pathname, method: request.method, body, authorization: request.headers.get('authorization') });
      if (url.hostname === 'fleet-auth.prd.vn.cloud.tesla.com' || url.hostname === 'auth-relay.example') {
        if(options.authEdge)return new MFResponse('<html>Access Denied</html>',{status:403,headers:{'Content-Type':'text/html'}});
        if (options.redirectToken) return new MFResponse(null, { status: 302, headers: { Location: 'https://untrusted.example/token' } });
        if (body.grant_type === 'refresh_token') refreshes++;
        return MFResponse.json({ access_token: `ACCESS-SECRET-${refreshes}`, refresh_token: `REFRESH-SECRET-${refreshes}`, expires_in: body.grant_type === 'refresh_token' ? 3600 : options.tokenExpiry || 3600 });
      }
      if (url.pathname === '/api/1/partner_accounts') return MFResponse.json({ response: { domain: 'garage.example.com' } });
      if (url.pathname === '/api/1/vehicles') {
        if (options.rateLimit) return MFResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '180' } });
        return MFResponse.json({ response: [{ vin, display_name: 'Test Tesla', state: options.online === false ? 'asleep' : 'online' }] });
      }
      if (url.pathname === `/api/1/vehicles/${vin}`) return MFResponse.json({ response: { vin, state: options.online === false ? 'asleep' : 'online' } });
      if (url.pathname.endsWith('/vehicle_data')) return MFResponse.json({ response: { vin, charge_state: { battery_level: 73, est_battery_range: 199 }, vehicle_state: { odometer: 15000 }, climate_state: { inside_temp: 22 } } });
      if (url.pathname === '/api/1/vehicles/fleet_status') return MFResponse.json({ response: options.legacy ? { key_paired_vins: [], vehicle_info: { [vin]: { vehicle_command_protocol_required: false, safety_screen_streaming_toggle_enabled: true, fleet_telemetry_version: '1.1.0' } } } : { key_paired_vins: [vin] } });
      if (url.pathname === '/configure') return MFResponse.json({ response: { updated_vehicles: options.skipped ? 0 : 1, skipped_vehicles: options.skipped ? { unsupported_hardware: [vin] } : {} } });
      if (url.pathname.endsWith('/fleet_telemetry_config')) return MFResponse.json({ response: { synced: true, config: { hostname: 'receiver.example.com' } } });
      if (url.pathname.endsWith('/fleet_telemetry_errors')) return MFResponse.json({ response: [] });
      throw new Error(`Unexpected outbound request: ${url.pathname}`);
    },
  }));
  instances.push(mf);
  if(options.d1){const db=await mf.getD1Database('HISTORY_DB');await db.batch(readFileSync('migrations/0001_history.sql','utf8').split(';').filter(s=>s.trim()).map(sql=>db.prepare(sql)));}
  let cookie = '';
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return mf.dispatchFetch(origin + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login() {
    const response = await request('/auth/login', 'POST', { password });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('set-cookie')!, /HttpOnly.*SameSite=Lax.*Secure/);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  }
  async function connect() {
    await login();
    const response = await request('/api/connect', 'POST', {});
    const { url } = await response.json() as any;
    assert.equal(new URL(url).origin, 'https://auth.tesla.com');
    assert.ok(!url.includes('test-secret'));
    const state = new URL(url).searchParams.get('state');
    const callback = await request(`/auth/callback?state=${state}&code=test-code`);
    assert.equal(callback.status, 303, await callback.clone().text());
    return state;
  }
  async function discover() { const r = await request('/api/vehicles/refresh', 'POST', {}); assert.equal(r.status, 200, await r.clone().text()); }
  return { mf, calls, request, login, connect, discover, refreshes: () => refreshes };
}

test('private data requires a session, writes require matching Origin, and key hosting supports Range', async () => {
  const f = await fixture();
  assert.equal((await f.request('/api/status')).status, 401);
  assert.equal((await f.request('/auth/login', 'POST', { password }, { Origin: 'https://evil.example' })).status, 403);
  await f.login();
  assert.equal((await f.request('/api/register', 'POST', {}, { Origin: 'https://evil.example' })).status, 403);
  const key = await f.request('/.well-known/appspecific/com.tesla.3p.public-key.pem', 'GET', undefined, { Range: 'bytes=0-20' });
  assert.equal(key.status, 206); assert.equal((await key.text()).length, 21);
  assert.match(key.headers.get('content-range')!, /^bytes 0-20\//);
  const response = await f.request('/api/status');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await f.request('/auth/logout', 'POST', {})).status, 200);
  assert.equal((await f.request('/api/status')).status, 401);
});

test('OAuth state is bound to the browser session, single-use, and token secrets stay server-side', async () => {
  const f = await fixture();
  const state = await f.connect();
  assert.equal((await f.request(`/auth/callback?state=${state}&code=replayed`)).status, 400);
  assert.equal((await f.request('/auth/callback?state=wrong&code=forged')).status, 400);
  const result = await f.request('/api/status');
  const text = await result.text(); assert.ok(!text.includes('ACCESS-SECRET')); assert.ok(!text.includes('REFRESH-SECRET'));
  assert.equal(JSON.parse(text).connected, true);
  const exchange = f.calls.find(c=>c.path.endsWith('/token'))!;
  assert.equal(exchange.body.redirect_uri, origin + '/auth/callback');
  assert.equal(exchange.body.audience, 'https://fleet-api.prd.na.vn.cloud.tesla.com');
});

test('telemetry retries are idempotent, out-of-order events cannot replace newer readings, null is preserved, and exports are complete', async () => {
  const f = await fixture(); await f.connect(); await f.discover();
  const timestamp = Date.now();
  const event = { id: 'evt-1', vin, kind: 'signal', field: 'Soc', value: 73, timestamp, timestampSource: 'receiver' };
  const ingestRequest = (events: any[], token = ingest) => f.request('/api/ingest', 'POST', { events }, { Authorization: `Bearer ${token}`, Origin: '' });
  assert.equal((await ingestRequest([event], 'bad')).status, 401);
  assert.equal((await ingestRequest([{ ...event, vin: '5YJ3E1EA7KF000002' }])).status, 403);
  assert.deepEqual(await (await ingestRequest([event])).json(), { accepted: 1, duplicates: 0 });
  assert.deepEqual(await (await ingestRequest([event])).json(), { accepted: 0, duplicates: 1 });
  await ingestRequest([{ ...event, id: 'older', timestamp: timestamp - 1000, value: 20 }, { ...event, id: 'null-value', field: 'Location', value: null }]);
  const details = await (await f.request(`/api/vehicles/${vin}`)).json() as any;
  assert.equal(details.signals.find((s:any)=>s.field==='Soc').value, 73);
  assert.equal(details.signals.find((s:any)=>s.field==='Location').value, null);
  const page = await (await f.request(`/api/vehicles/${vin}/history?limit=2`)).json() as any;
  assert.equal(page.events.length, 2); assert.ok(page.nextCursor);
  const next = await (await f.request(`/api/vehicles/${vin}/history?limit=2&cursor=${page.nextCursor}`)).json() as any;
  assert.equal(next.events.length, 1); assert.equal(next.nextCursor, null);
  const exported = await (await f.request(`/api/vehicles/${vin}/export?all=1`)).text();
  assert.equal(exported.trim().split('\n').length, 3);
  const teslaCount = f.calls.length;
  await f.request(`/api/vehicles/${vin}`); await f.request('/api/status');
  assert.equal(f.calls.length, teslaCount, 'dashboard views must not poll Tesla');
});

test('asleep vehicles are never woken or queried for vehicle data', async () => {
  const f = await fixture({ online: false }); await f.connect(); await f.discover();
  const response = await f.request(`/api/vehicles/${vin}/snapshot`, 'POST', {});
  assert.equal(response.status, 409);
  assert.ok(!f.calls.some(c=>c.path.includes('wake_up') || c.path.includes('vehicle_data')));
});

test('snapshots use explicit data groups and enforce cooldown; stored raw data is exportable', async () => {
  const f = await fixture(); await f.connect(); await f.discover();
  assert.equal((await f.request(`/api/vehicles/${vin}/snapshot`, 'POST', {})).status, 200);
  assert.equal((await f.request(`/api/vehicles/${vin}/snapshot`, 'POST', {})).status, 429);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/vehicle_data')).length, 1);
  const exported = await (await f.request(`/api/vehicles/${vin}/export?all=1`)).text();
  assert.equal(JSON.parse(exported.trim()).value.charge_state.battery_level, 73);
});

test('Tesla 429 pauses subsequent upstream calls and preserves Retry-After', async () => {
  const f = await fixture({ rateLimit: true }); await f.connect();
  const response = await f.request('/api/vehicles/refresh', 'POST', {});
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '180');
  const count = f.calls.length;
  assert.equal((await f.request('/api/register', 'POST', {})).status, 429);
  assert.equal(f.calls.filter(c=>!c.path.endsWith('/token')).length, 1);
  assert.ok(f.calls.length <= count + 1);
});

test('expired access tokens refresh once across concurrent API operations', async () => {
  const f = await fixture({ tokenExpiry: 1 }); await f.connect();
  await Promise.all([f.request('/api/vehicles/refresh', 'POST', {}), f.request('/api/register', 'POST', {})]);
  assert.equal(f.refreshes(), 1);
});

test('signed streaming setup checks key pairing and passes config to the authenticated receiver', async () => {
  const f = await fixture(); await f.connect(); await f.discover();
  const response = await f.request(`/api/vehicles/${vin}/telemetry`, 'POST', { preset: 'complete' });
  assert.equal(response.status, 200, await response.clone().text());
  const call = f.calls.find(c=>c.path==='/configure')!;
  assert.ok(Object.keys(call.body.config.fields).length > 200);
  assert.ok(call.authorization?.startsWith('Bearer ACCESS-SECRET'));
  assert.equal((await f.request(`/api/vehicles/${vin}/telemetry`, 'DELETE')).status, 200);
  const status = await (await f.request('/api/status')).json() as any;
  assert.equal(status.vehicles[0].collecting, false);
});

test('a skipped Tesla telemetry configuration is never reported as collecting', async () => {
  const f = await fixture({ skipped: true }); await f.connect(); await f.discover();
  const response = await f.request(`/api/vehicles/${vin}/telemetry`, 'POST', { preset: 'complete' });
  assert.equal(response.status, 409);
  const status = await (await f.request('/api/status')).json() as any;
  assert.equal(status.vehicles[0].collecting, false);
});

test('outbound redirects cannot forward Tesla credentials to another server', async () => {
  const f = await fixture({ redirectToken: true }); await f.login();
  const response = await f.request('/api/register', 'POST', {});
  assert.equal(response.status, 502);
  assert.equal(f.calls.length, 1);
});

test('numeric strings chart correctly while the original string remains in history', async () => {
  const f = await fixture(); await f.connect(); await f.discover();
  const event = { id: 'numeric-string', vin, kind: 'signal', field: 'Soc', value: '72.5', timestamp: Date.now(), timestampSource: 'receiver' };
  const response = await f.request('/api/ingest', 'POST', { events: [event] }, { Authorization: `Bearer ${ingest}` });
  assert.equal(response.status, 200);
  const series = await (await f.request(`/api/vehicles/${vin}/series?field=Soc`)).json() as any;
  assert.equal(series.points[0].value, 72.5);
  const history = await (await f.request(`/api/vehicles/${vin}/history`)).json() as any;
  assert.equal(history.events[0].value, '72.5');
});

test('supported legacy Model S/X can use the in-car streaming toggle without a virtual key', async () => {
  const f = await fixture({ legacy: true }); await f.connect(); await f.discover();
  const response = await f.request(`/api/vehicles/${vin}/telemetry`, 'POST', { preset: 'essentials' });
  assert.equal(response.status, 200, await response.clone().text());
});


test('D1 persists telemetry and snapshots, handles duplicate IDs, and serves history/exports', async () => {
  const f=await fixture({d1:true});await f.connect();await f.discover();
  const event={id:'d1-event',vin,kind:'signal',field:'Location',value:{latitude:35.9,longitude:-78.6},timestamp:Date.now(),timestampSource:'receiver'};
  const send=(e:any)=>f.request('/api/ingest','POST',{events:[e]},{Authorization:`Bearer ${ingest}`});
  assert.equal((await send(event)).status,200);
  const duplicate=await send({...event,value:{latitude:0,longitude:0}});
  assert.equal((await duplicate.json() as any).duplicates,1);
  const details=await (await f.request(`/api/vehicles/${vin}`)).json() as any;
  assert.deepEqual(details.signals[0].value,event.value);
  assert.equal((await f.request(`/api/vehicles/${vin}/snapshot`,'POST',{})).status,200);
  const exported=await (await f.request(`/api/vehicles/${vin}/export?all=1`)).text();
  assert.equal(exported.trim().split('\n').length,2);
  const db=await f.mf.getD1Database('HISTORY_DB');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM events').first() as any).n,2);
  const status=await (await f.request('/api/status')).json() as any;
  assert.equal(status.historyStorage,'Cloudflare D1');
});

for(const d1 of [false,true]) test(`trip history from ${d1?'D1':'local SQLite'} stays private, includes late data, and never polls Tesla`,async()=>{
 const f=await fixture({d1});const start=Date.now()-120000,window=`from=${start-60000}&to=${start+180000}`;
 assert.equal((await f.request(`/api/vehicles/${vin}/trips?${window}`)).status,401);
 await f.connect();await f.discover();
 const events=[['Gear','ShiftStateD',0],['Location',{latitude:36,longitude:-78},0],['VehicleSpeed',25,10000],['Location',{latitude:36.003,longitude:-78},30000],['Gear','ShiftStateP',60000]].map(([field,value,offset],i)=>({id:`trip-${i}`,vin,kind:'signal',field,value,timestamp:start+Number(offset),timestampSource:'receiver'}));
 assert.equal((await f.request('/api/ingest','POST',{events},{Authorization:`Bearer ${ingest}`})).status,200);
 const calls=f.calls.length;
 const first=await f.request(`/api/vehicles/${vin}/trips?${window}`);assert.equal(first.status,200);const result=await first.json() as any;
 assert.equal(result.trips.length,1);assert.equal(result.trips[0].state,'completed');assert.equal(result.trips[0].points.length,2);assert.equal(result.truncated,false);
 const late={...events[1],id:'trip-late',value:{latitude:36.006,longitude:-78},timestamp:start+55000};
 assert.equal((await f.request('/api/ingest','POST',{events:[late,events[1]]},{Authorization:`Bearer ${ingest}`})).status,200);
 const reread=await (await f.request(`/api/vehicles/${vin}/trips?${window}`)).json() as any;assert.equal(reread.trips[0].points.length,3);assert.equal(reread.trips[0].id,result.trips[0].id);
 assert.equal(f.calls.length,calls,'trip views do not call Tesla');
 assert.equal((await f.request(`/api/vehicles/${vin}/trips?from=NaN&to=0`)).status,400);
 assert.equal((await f.request(`/api/vehicles/${vin}/trips?from=${start}&to=${start+3*86400000}`)).status,400);
 assert.equal((await f.request(`/api/vehicles/5YJ3E1EA7KF000002/trips?${window}`)).status,404);
 assert.equal((await (await f.request('/api/status')).json() as any).retentionDays,0);
});


test('configured auth relay handles partner tokens, OAuth exchange, and refresh',async()=>{
 const f=await fixture({authRelay:true,tokenExpiry:1});await f.connect();
 assert.equal((await f.request('/api/register','POST',{})).status,200);
 await f.discover();
 const tokenCalls=f.calls.filter(c=>c.path==='/oauth/token');
 assert.ok(tokenCalls.some(c=>c.body.grant_type==='client_credentials'));
 assert.ok(tokenCalls.some(c=>c.body.grant_type==='authorization_code'));
 assert.ok(tokenCalls.some(c=>c.body.grant_type==='refresh_token'));
 assert.ok(tokenCalls.every(c=>c.authorization==='Bearer test-relay-secret-12345678901234567890'));
 assert.equal(f.calls.filter(c=>c.path==='/oauth2/v3/token').length,0);
});
test('edge denial is distinguished from permission and billing errors',async()=>{
 const f=await fixture({authEdge:true});await f.login();const r=await f.request('/api/register','POST',{});
 assert.equal(r.status,403);assert.match((await r.json() as any).error,/edge network blocked/);
});
