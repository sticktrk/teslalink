import http from 'node:http';
import { remoteD1 } from './d1.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import worker, { Garage } from '../src/index.ts';

process.umask(0o077);
const origin = new URL(process.env.APP_URL || 'http://localhost:8788');
const dbPath = resolve(process.env.DATABASE_PATH || './data/tesla.sqlite');
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runtime_meta(key TEXT PRIMARY KEY,value INTEGER);');
const sql = {
  exec(query, ...bindings) {
    if (!bindings.length && query.split(';').filter(s=>s.trim()).length > 1) { db.exec(query); return { toArray: () => [] }; }
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  },
  get databaseSize() { return Number(db.prepare('PRAGMA page_count').get().page_count) * Number(db.prepare('PRAGMA page_size').get().page_size); },
};
const storage = {
  sql,
  transactionSync(fn) { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(error) { db.exec('ROLLBACK'); throw error; } },
  async getAlarm() { return db.prepare("SELECT value FROM runtime_meta WHERE key='alarm'").get()?.value ?? null; },
  async setAlarm(time) { db.prepare("INSERT INTO runtime_meta VALUES('alarm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(Number(time)); },
};
const assets = new Map(Object.entries({ '/':'index.html', '/index.html':'index.html', '/app.js':'app.js', '/mileage.js':'mileage.js', '/mileage-print.css':'mileage-print.css', '/style.css':'style.css', '/favicon.svg':'favicon.svg', '/vendor/leaflet/leaflet.js':'vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css':'vendor/leaflet/leaflet.css' }).map(([url,file])=>[url, { data:readFileSync(resolve('public',file)), type:({'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8','svg':'image/svg+xml'})[file.split('.').at(-1)] }]));
const env = { ...process.env, ASSETS: { async fetch(request) { const asset=assets.get(new URL(request.url).pathname); return asset ? new Response(request.method==='HEAD'?null:asset.data,{headers:{'Content-Type':asset.type}}) : new Response('Not found',{status:404}); } } };
if (process.env.STORAGE_API_URL) env.HISTORY_DB=remoteD1(process.env.STORAGE_API_URL,process.env.STORAGE_API_TOKEN);
const garage = new Garage({ storage }, env);
env.GARAGE = { idFromName: name=>name, get: ()=>({fetch:request=>garage.fetch(request)}) };
let closing=false, maintaining=false;
const maintenance=setInterval(async()=>{
  if(closing||maintaining)return;
  const deadline=await storage.getAlarm();
  if(deadline===null||deadline>Date.now())return;
  maintaining=true;
  try { await garage.alarm(); } catch { console.error('Maintenance failed; will retry.'); } finally { maintaining=false; }
},5000);
maintenance.unref();
const server=http.createServer(async(req,res)=>{
  try {
    const headers=new Headers();
    for(const [name,value] of Object.entries(req.headers)) if(value)headers.set(name,Array.isArray(value)?value.join(', '):value);
    headers.set('cf-connecting-ip',req.headers['x-real-ip']||req.socket.remoteAddress||'local');
    const request=new Request(`${origin.protocol}//${req.headers.host}${req.url}`,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const response=await worker.fetch(request,env);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body)await pipeline(Readable.fromWeb(response.body),res);else res.end();
  } catch(error) { if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"Request failed"}');}else res.destroy(); console.error('HTTP request failed:',error.name); }
});
server.requestTimeout=60000;server.headersTimeout=15000;
server.listen(Number(process.env.PORT||8788),'127.0.0.1',()=>console.log('Tesla Link listening on loopback port',process.env.PORT||8788));
function stop(){closing=true;clearInterval(maintenance);server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),30000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
