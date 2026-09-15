const $ = (selector) => document.querySelector(selector);
const app = $('#app');
let status, details, catalog, vin = '', tab = 'overview', search = '', category = '', historyCursor = '', historyPrevious = [], toastTimer;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number = (value, digits = 0) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
const date = (value) => value ? new Date(value).toLocaleString() : 'Not yet';
const age = (value) => !value ? 'No data yet' : Date.now() - value < 60000 ? 'Less than a minute ago' : Date.now() - value < 3600000 ? `${Math.floor((Date.now() - value) / 60000)} min ago` : date(value);
const value = (v) => v === null ? 'Unavailable' : typeof v === 'object' ? JSON.stringify(v) : String(v);

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') {
      const session = await fetch('/api/session').then(r => r.json());
      if (!session.authenticated) showLogin(session);
    }
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
function notify(message, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.className = error ? 'error' : ''; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 12000 : 6500);
}
async function action(button, fn) {
  if (button?.disabled) return;
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Working…'; }
  try { await fn(); } catch (error) { notify(error.message, true); }
  finally { if (button?.isConnected) { button.disabled = false; button.textContent = original; } }
}
function signal(name) { return details?.signals.find(s => s.field === name); }
function current(name, snapshotPath) {
  const item = signal(name);
  const fallback = snapshotPath?.split('.').reduce((v, key) => v?.[key], details?.snapshot?.data);
  return item && (!details?.snapshot || item.timestamp >= details.snapshot.timestamp) ? item.value : fallback ?? item?.value;
}

function showLogin(session) {
  $('#logout').hidden = true;
  app.removeAttribute('aria-busy');
  app.innerHTML = `<section class="login"><p class="eyebrow">YOUR PRIVATE GARAGE</p><h1>Keep a closer eye<br>on your Tesla.</h1><p class="muted">Battery, charging, driving, and the details in between. All your collected vehicle data in one place.</p><form id="login-form" class="panel"><label for="password">App password</label><input id="password" name="password" type="password" autocomplete="current-password" required ${!session.configured ? 'disabled' : ''}><button class="primary" ${!session.configured ? 'disabled' : ''}>Open garage</button><p id="login-error" class="inline-error" role="alert"></p>${!session.configured ? '<p class="notice">Set APP_PASSWORD to at least 24 random characters in your Cloudflare secrets to open the app. Deployment instructions are in the project README.</p>' : '<p class="notice">Use the app password you configured, then connect your Tesla account inside.</p>'}</form></section>`;
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { await post('/auth/login', { password: $('#password').value }); await load(); }
    catch (error) { $('#login-error').textContent = error.message; button.disabled = false; }
  });
}

async function load(preserve = false) {
  const next = await api('/api/status');
  status = next;
  if (!catalog) catalog = await api('/api/catalog');
  if (!status.vehicles.some(v => v.vin === vin)) vin = status.vehicles[0]?.vin || '';
  details = vin ? await api(`/api/vehicles/${vin}`) : null;
  if (!preserve) render();
}

function render() {
  $('#logout').hidden = false; app.removeAttribute('aria-busy');
  const car = status.vehicles.find(v => v.vin === vin);
  app.innerHTML = `<div class="page-heading"><div><p class="eyebrow">VEHICLE DATA / GARAGE</p><h1>${car ? esc(car.name) : 'Your garage'}</h1><p class="vin">${car ? esc(car.vin) : 'Connect once. Collect while your car is awake.'}</p></div><div class="vehicle-picker">${car ? `<label for="vehicle">Vehicle</label><select id="vehicle">${status.vehicles.map(v => `<option value="${esc(v.vin)}" ${v.vin === vin ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>` : ''}</div></div>
    ${setupBanner()}
    ${car ? `${stats()}<nav class="tabs" role="tablist" aria-label="Vehicle views">${['overview','signals','collection','history'].map(t => `<button id="tab-${t}" role="tab" aria-selected="${tab === t}" aria-controls="tab-panel" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}${t === 'signals' ? ` · ${details.signals.filter(s=>s.field !== '_connectivity').length}` : ''}</button>`).join('')}</nav><section id="tab-panel" role="tabpanel" aria-labelledby="tab-${tab}"></section>` : noCar()}`;
  $('#vehicle')?.addEventListener('change', event => { vin = event.target.value; historyCursor = ''; historyPrevious = []; action(null, load); });
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab; render(); $(`#tab-${tab}`).focus(); }));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => handleGlobal(button)));
  if (car) renderTab();
}

function setupBanner() {
  if (status.missing.length) return `<section class="panel setup-banner"><h2>Finish your connection setup</h2><p class="muted small">Add these environment secrets, then register the app with Tesla.</p><p>${status.missing.map(key=>`<code>${esc(key)}</code>`).join('')}</p><a href="https://developer.tesla.com/" target="_blank" rel="noreferrer">Tesla developer dashboard ↗</a></section>`;
  if (status.authError || !status.connected || !status.registeredAt) return `<section class="panel setup-banner"><h2>${status.authError ? 'Reconnect your Tesla' : !status.registeredAt ? 'Register this app with Tesla' : 'Connect your Tesla account'}</h2><p class="muted small">${esc(status.authError || (!status.registeredAt ? 'Make sure your public domain and callback URL are saved in the Tesla developer dashboard.' : 'Sign in with Tesla and approve vehicle data and location access.'))}</p><div class="row"><button data-action="register" ${status.registeredAt ? 'class="quiet"' : 'class="primary"'}>Register app</button><button data-action="connect" class="${status.registeredAt ? 'primary' : 'quiet'}">${status.connected ? 'Reconnect Tesla' : 'Connect Tesla'}</button></div></section>`;
  return '';
}

function noCar() {
  return `<section class="panel no-car"><div class="stack"><div><h2>Ready when your car is.</h2><p class="muted">Connect your account to find your vehicles. You can take a snapshot immediately, then enable streaming for continuous collection.</p></div><div class="row"><button class="primary" data-action="discover" ${!status.connected ? 'disabled' : ''}>Find my vehicles</button></div><p class="small muted">Tesla API access and a billing limit must be enabled in your Tesla developer account.</p></div><ol class="steps"><li><div><strong>Connect your Tesla</strong><p class="muted small">Approve data access through Tesla’s secure sign-in.</p></div></li><li><div><strong>Pair your app key</strong><p class="muted small">Open the pairing link on your phone, near your car.</p></div></li><li><div><strong>Start collecting</strong><p class="muted small">Set up the included receiver, choose a preset, and let the vehicle stream when awake.</p></div></li></ol></section>`;
}

function stats() {
  const recent = details.signals.reduce((v,s)=>Math.max(v,s.timestamp), details.snapshot?.timestamp || 0);
  return `<section class="stats" aria-label="Vehicle summary"><div class="stat"><p class="stat-label">Battery</p><p class="stat-value accent">${number(current('Soc','charge_state.battery_level'),1)}<small>%</small></p><p class="small muted">Last known charge</p></div><div class="stat"><p class="stat-label">Estimated range</p><p class="stat-value">${number(current('EstBatteryRange','charge_state.est_battery_range'))}<small>mi</small></p><p class="small muted">Tesla estimate</p></div><div class="stat"><p class="stat-label">Odometer</p><p class="stat-value">${number(current('Odometer','vehicle_state.odometer'))}<small>mi</small></p><p class="small muted">Total distance</p></div><div class="stat"><p class="stat-label">Signals received</p><p class="stat-value">${details.signals.filter(s=>s.field!=='_connectivity').length}<small>/ ${status.fieldCount}</small></p><p class="small muted">${esc(age(recent))}</p></div></section>`;
}

async function handleGlobal(button) {
  return action(button, async () => {
    if (button.dataset.action === 'connect') { const result = await post('/api/connect'); location.assign(result.url); return; }
    if (button.dataset.action === 'register') { await post('/api/register'); notify('App registered for this Tesla region.'); }
    if (button.dataset.action === 'discover') { const result = await post('/api/vehicles/refresh'); notify(`${result.count} vehicle${result.count === 1 ? '' : 's'} found.`); }
    await load();
  });
}

function renderTab() {
  if (tab === 'overview') overview();
  else if (tab === 'signals') signals();
  else if (tab === 'collection') collection();
  else history();
}

function overview() {
  const car = status.vehicles.find(v=>v.vin===vin);
  const connectivity = signal('_connectivity');
  const charge = current('DetailedChargeState','charge_state.charging_state');
  $('#tab-panel').innerHTML = `<div class="overview-grid"><section class="panel"><div class="panel-header"><div><h2>Battery over time</h2><p class="muted small">Last 24 hours · 5-minute averages</p></div><span class="badge neutral">Stored readings</span></div><div id="battery-chart" class="chart-empty"><p>Waiting for battery readings.<br>Streaming fills in your history automatically.</p></div><p class="notice">Readings arrive when values change. Gaps can mean the car was asleep or disconnected; the dashboard never wakes it.</p></section><section class="panel"><div class="panel-header"><h2>Collection status</h2><span class="badge ${car.collecting ? '' : 'neutral'}">${car.collecting ? 'Configured' : 'Not configured'}</span></div><dl class="details"><dt>Last received</dt><dd>${esc(age(status.lastIngestAt))}</dd><dt>Charging</dt><dd>${esc(charge == null ? '—' : value(charge))}</dd><dt>Cabin temperature</dt><dd>${number(current('InsideTemp','climate_state.inside_temp'),1)} °C</dd><dt>Connection event</dt><dd>${esc(connectivity ? value(connectivity.value?.Status || connectivity.value) : 'No event yet')}</dd><dt>History retention</dt><dd>${status.retentionDays === 0 ? 'Indefinite' : `${status.retentionDays} days`}</dd><dt>Vehicle history</dt><dd>${esc(status.historyStorage || "SQLite")}</dd><dt>Local account storage</dt><dd>${number(status.storageBytes / 1048576,1)} MB</dd></dl><p class="notice">${car.renewal ? esc(car.renewal) : car.collecting ? 'Configuration renews automatically while it remains active at Tesla.' : 'Open Collection to set up continuous streaming.'}</p></section></div><section class="panel snapshot"><div class="panel-header"><div><h2>Vehicle snapshot</h2><p class="muted small">${details.snapshot ? `Captured ${esc(date(details.snapshot.timestamp))}` : 'A one-time read of the available vehicle data'}</p></div><button id="snapshot">Take snapshot</button></div><p class="small muted">Snapshots are billed by Tesla. Limited to one every ${Math.ceil(status.limits.snapshotCooldown/60)} minutes and ${status.limits.snapshotDailyLimit} per day, per vehicle. The car must already be online.</p>${details.snapshot ? `<details><summary>View full snapshot JSON</summary><pre>${esc(JSON.stringify(details.snapshot.data,null,2))}</pre></details>` : ''}</section>`;
  $('#snapshot').addEventListener('click', event => action(event.target, async () => { await post(`/api/vehicles/${vin}/snapshot`); notify('Snapshot saved.'); await load(); }));
  const expectedVin = vin;
  api(`/api/vehicles/${vin}/series?field=Soc`).then(result => {
    if (tab !== 'overview' || expectedVin !== vin) return;
    if (!result.points.length) return api(`/api/vehicles/${vin}/series?field=BatteryLevel`).then(fallback => { if (tab === 'overview' && expectedVin === vin) drawChart(fallback.points); });
    drawChart(result.points);
  }).catch(error=>notify(error.message,true));
}

function drawChart(points) {
  if (!points?.length || !$('#battery-chart')) return;
  const chart = $('#battery-chart'); chart.className = '';
  const start = Date.now() - 86400000, end = Date.now();
  const x = t => 40 + (t-start)/(end-start)*680, y = v => 205 - Math.max(0,Math.min(100,v))*1.8;
  let d = '', last = 0;
  points.forEach(p => { d += `${p.timestamp-last > 900000 ? 'M' : 'L'} ${x(p.timestamp).toFixed(1)} ${y(Number(p.value)).toFixed(1)} `; last=p.timestamp; });
  chart.innerHTML = `<svg class="chart" viewBox="0 0 740 245" role="img" aria-label="Battery percentage over the past 24 hours"><title>Battery percentage, 5-minute averages. Gaps longer than 15 minutes are disconnected.</title>${[0,25,50,75,100].map(v=>`<line x1="40" x2="720" y1="${y(v)}" y2="${y(v)}" stroke="#30393c"/><text x="0" y="${y(v)+4}">${v}%</text>`).join('')}<path d="${d}" fill="none" stroke="#a7f3c5" stroke-width="2.5"/>${points.map(p=>`<circle cx="${x(p.timestamp)}" cy="${y(Number(p.value))}" r="2.3" fill="#a7f3c5"><title>${esc(date(p.timestamp))}: ${number(p.value,1)}%</title></circle>`).join('')}<text x="40" y="235">24 hours ago</text><text x="690" y="235">Now</text></svg>`;
}

function signals() {
  const categories = [...new Set(catalog.fields.map(f=>f.category))].sort();
  $('#tab-panel').innerHTML = `<section class="panel"><div class="panel-header"><div><h2>All received signals</h2><p class="small muted">Latest values · Original Tesla field names</p></div><button id="refresh-stored" class="quiet">Refresh view</button></div><div class="signal-toolbar"><div><label for="signal-search">Find a signal</label><input id="signal-search" type="search" placeholder="Search battery, temperature, location…" value="${esc(search)}"></div><div><label for="category">Category</label><select id="category"><option value="">All categories</option>${categories.map(c=>`<option ${category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div></div><p id="signal-count" class="small muted"></p><div class="table-wrap"><table><thead><tr><th>Signal</th><th>Value</th><th>Category</th><th>Last received</th></tr></thead><tbody id="signal-rows"></tbody></table></div></section>`;
  $('#signal-search').addEventListener('input',event=>{search=event.target.value;signalRows();});
  $('#category').addEventListener('change',event=>{category=event.target.value;signalRows();});
  $('#refresh-stored').addEventListener('click',event=>action(event.target,load));
  signalRows();
}

function signalRows() {
  const fields = new Map(catalog.fields.map(f=>[f.name,f]));
  const rows = details.signals.filter(s=>s.field !== '_connectivity' && (!category || fields.get(s.field)?.category===category) && `${s.field} ${fields.get(s.field)?.category || ''}`.toLowerCase().includes(search.toLowerCase()));
  $('#signal-count').textContent = `${rows.length} signals · Null means Tesla reported an unavailable value. Timestamps identify the receiver or vehicle source.`;
  $('#signal-rows').innerHTML = rows.length ? rows.map(s=>`<tr><td>${esc(s.field)}</td><td class="value">${esc(value(s.value))}</td><td>${esc(fields.get(s.field)?.category || 'Other')}</td><td class="time" title="${esc(date(s.timestamp))}">${esc(age(s.timestamp))}<br><span class="small">${esc(s.timestamp_source)}</span></td></tr>`).join('') : '<tr><td colspan="4" class="empty">No matching signals yet. Enable streaming in Collection to start receiving data.</td></tr>';
}

function collection() {
  const car = status.vehicles.find(v=>v.vin===vin);
  $('#tab-panel').innerHTML = `<div class="collection-grid"><section class="panel stack"><div><h2>Collect what matters to you</h2><p class="small muted">Tesla sends each field only when it changes and its interval has elapsed.</p></div><div class="preset-options">${[['essentials','Essentials','Core battery, charging, location, and vehicle state. Lower signal volume.'],['complete','Complete',`${status.fieldCount} passenger-vehicle signals. Driving every 10 seconds; most fields every 60–300 seconds.`],['high-detail','High detail','The same broad coverage, with key driving signals up to once per second. Higher Tesla usage.']].map(([id,title,desc])=>`<label class="preset"><input type="radio" name="preset" value="${id}" ${id==='complete'?'checked':''}><strong>${title}</strong><span>${desc}</span></label>`).join('')}</div><label class="check"><input id="include-location" type="checkbox" checked>Include precise location and navigation</label><p class="small muted">Signals vary by model, hardware, firmware, and permissions. Selecting a field does not guarantee the car supports it.</p><div class="row"><button id="enable" class="primary" ${status.streamingMissing.length?'disabled':''}>${car.collecting ? 'Update streaming' : 'Enable streaming'}</button><button id="stop" class="quiet" ${!car.collecting?'disabled':''}>Stop streaming</button></div><p class="notice warn">${status.streamingMissing.length ? `Receiver setup required: ${status.streamingMissing.map(esc).join(', ')}. See receiver/README.md in the project.` : 'Set a billing cap in the Tesla developer dashboard. A high-detail preset can generate substantial paid usage; API rate limits are not a spending cap.'}</p></section><section class="panel"><div class="panel-header"><h2>Field configuration</h2><button id="download-config" class="quiet">Download</button></div><label for="fields-json">Review or customize intervals (seconds) and minimum changes</label><textarea id="fields-json" spellcheck="false">${esc(JSON.stringify(details.vehicle.config || catalog.presets.complete,null,2))}</textarea><p id="field-count" class="small muted"></p><p class="notice">The app signs configuration through your receiver and renews it before expiry. Removed configurations require you to enable streaming again.</p><div class="row"><a class="button quiet" href="${esc(status.pairingUrl)}" target="_blank" rel="noreferrer">Pair app key ↗</a><button id="diagnostics" class="quiet">Check diagnostics</button></div><div id="diagnostics-result">${details.diagnostics ? `<details><summary>Last diagnostics · ${esc(date(details.diagnostics.timestamp))}</summary><pre class="diagnostics">${esc(JSON.stringify(details.diagnostics.result,null,2))}</pre></details>` : ''}</div></section></div><section class="panel snapshot"><div class="panel-header"><h2>Tesla account</h2><button data-action="discover" class="quiet">Refresh vehicles</button></div><p class="small muted">Connected in the ${esc(status.region.toUpperCase())} region. Dashboard refreshes read your stored data and do not request vehicle data from Tesla.</p><p class="notice"><a href="${esc(status.revokeUrl)}" target="_blank" rel="noreferrer">Manage or revoke Tesla access ↗</a> · Revoking access at Tesla also removes the vehicle’s streaming configuration.</p></section>`;
  const editor = $('#fields-json');
  const updateCount=()=>{try{$('#field-count').textContent=`${Object.keys(JSON.parse(editor.value)).length} fields selected`;}catch{$('#field-count').textContent='Configuration must be valid JSON.';}};
  const applyPreset=()=>{const fields=structuredClone(catalog.presets[$('input[name=preset]:checked').value]);if(!$('#include-location').checked)for(const field of ['Location','OriginLocation','DestinationLocation','DestinationName','RouteLine','GpsState','GpsHeading'])delete fields[field];editor.value=JSON.stringify(fields,null,2);updateCount();};
  document.querySelectorAll('input[name=preset],#include-location').forEach(input=>input.addEventListener('change',applyPreset));
  editor.addEventListener('input',updateCount);updateCount();
  $('#enable').addEventListener('click',event=>action(event.target,async()=>{await post(`/api/vehicles/${vin}/telemetry`,{fields:JSON.parse(editor.value)});notify('Configuration accepted. Check diagnostics for sync status; signals arrive when the car is awake.');await load();}));
  $('#stop').addEventListener('click',event=>action(event.target,async()=>{await api(`/api/vehicles/${vin}/telemetry`,{method:'DELETE'});notify('Streaming configuration removed.');await load();}));
  $('#download-config').addEventListener('click',()=>{try{download(JSON.stringify({fields:JSON.parse(editor.value)},null,2),'tesla-fields.json','application/json');}catch{notify('Fix the JSON before downloading.',true);}});
  $('#diagnostics').addEventListener('click',event=>action(event.target,async()=>{const result=await post(`/api/vehicles/${vin}/diagnostics`);$('#diagnostics-result').innerHTML=`<pre class="diagnostics">${esc(JSON.stringify(result,null,2))}</pre>`;notify('Diagnostics updated.');}));
  document.querySelector('[data-action="discover"]').addEventListener('click',event=>handleGlobal(event.target));
}

async function history() {
  const expectedVin=vin;
  $('#tab-panel').innerHTML = `<section class="panel"><div class="panel-header"><div><h2>Collected history</h2><p class="small muted">Signals, snapshots, connectivity, alerts, and errors · ${status.retentionDays === 0 ? 'Retained indefinitely' : `${status.retentionDays}-day retention`}</p></div><a class="button quiet" href="/api/vehicles/${vin}/export?all=1">Export all NDJSON</a></div><div class="row spread export-actions"><span class="small muted">Oldest first · 100 events per page</span><div class="row"><button id="history-prev" class="quiet" ${historyPrevious.length?'':'disabled'}>Previous</button><button id="history-next" class="quiet" disabled>Next</button></div></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Type / Field</th><th>Value</th></tr></thead><tbody id="history-rows"><tr><td colspan="3" class="empty">Loading history…</td></tr></tbody></table></div></section>`;
  try {
    const result = await api(`/api/vehicles/${vin}/history?limit=100&cursor=${encodeURIComponent(historyCursor)}`);
    if(tab!=='history'||vin!==expectedVin)return;
    $('#history-rows').innerHTML=result.events.length?result.events.map(e=>`<tr><td class="time">${esc(date(e.timestamp))}<br>${esc(e.timestamp_source)}</td><td>${esc(e.kind)} / ${esc(e.field)}</td><td class="value">${e.kind==='snapshot'?`<details><summary>View vehicle snapshot</summary><pre class="diagnostics">${esc(JSON.stringify(e.value,null,2))}</pre></details>`:esc(value(e.value))}</td></tr>`).join(''):'<tr><td colspan="3" class="empty">Your first readings will appear here.</td></tr>';
    $('#history-next').disabled=!result.nextCursor;
    $('#history-next').addEventListener('click',()=>{historyPrevious.push(historyCursor);historyCursor=result.nextCursor;history();});
    $('#history-prev').addEventListener('click',()=>{historyCursor=historyPrevious.pop()||'';history();});
  }catch(error){notify(error.message,true);}
}

function download(content,name,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
$('#logout').addEventListener('click',event=>action(event.target,async()=>{await post('/auth/logout');status=null;details=null;showLogin({configured:true});}));
async function start(){try{const session=await api('/api/session');if(session.authenticated){await load();const connection=new URLSearchParams(location.search).get('connection');if(connection){notify(connection==='success'?'Tesla connected. Use Find my vehicles or Refresh vehicles to discover your car.':'Tesla sign-in was cancelled.',connection!=='success');window.history.replaceState({},'',location.pathname);}}else showLogin(session);}catch(error){app.removeAttribute('aria-busy');app.innerHTML=`<section class="panel"><h1>Setup needs attention</h1><p class="notice">${esc(error.message)}</p><p class="small muted">Check APP_URL and your Cloudflare bindings, then reload this page.</p></section>`;}}
await start();
// Refresh only the stored overview. Never replace an in-progress configuration edit.
setInterval(async()=>{if(!status||tab!=='overview'||document.hidden)return;try{await load(true);if(tab==='overview')render();}catch{}},60000);
