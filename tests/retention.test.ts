import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
let Garage: any;
before(async () => {
  const output = await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'node',write:false,alias:{'cloudflare:workers':resolve('server/cloudflare-shim.mjs')}});
  Garage = (await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))).Garage;
});
for (const remote of [false,true]) for (const retention of [undefined,'0','30']) {
  test(`${remote?'D1-compatible':'local'} maintenance: retention ${retention??'default'} preserves history unless expiry is explicit`,async()=>{
    const local=new DatabaseSync(':memory:'), history=remote?new DatabaseSync(':memory:'):local;
    const sql={exec(query:string,...params:any[]){if(!params.length&&query.split(';').filter(x=>x.trim()).length>1){local.exec(query);return {toArray:()=>[]};}const rows=local.prepare(query).all(...params);return {toArray:()=>rows};}};
    let alarm=0;
    const binding={prepare(query:string){return {bind(...params:any[]){return {async all(){return {results:history.prepare(query).all(...params)}}}}}}};
    const garage=new Garage({storage:{sql,async setAlarm(t:number){alarm=t;}}},{RETENTION_DAYS:retention,...(remote?{HISTORY_DB:binding}:{})});
    if(remote)history.exec(readFileSync('migrations/0001_history.sql','utf8'));
    const old=Date.now()-500*86400000,recent=Date.now();
    for(const [id,t] of [['old',old],['recent',recent]] as const){history.prepare('INSERT INTO events(id,vin,kind,field,value,timestamp,timestamp_source,received_at) VALUES(?,?,?,?,?,?,?,?)').run(id,'VIN','signal','Location','{}',t,'receiver',t);history.prepare('INSERT INTO snapshots(vin,timestamp,data) VALUES(?,?,?)').run('VIN',t,'{}');}
    local.prepare('INSERT INTO sessions VALUES(?,?,?)').run('expired',old,'hash');
    await garage.alarm();
    assert.equal(history.prepare('SELECT COUNT(*) n FROM events').get()!.n,retention==='30'?1:2);
    assert.equal(history.prepare('SELECT COUNT(*) n FROM snapshots').get()!.n,retention==='30'?1:2);
    assert.equal(local.prepare('SELECT COUNT(*) n FROM sessions').get()!.n,0);
    assert.ok(alarm>Date.now()+3500000,'hourly maintenance remains scheduled');
    if(remote)history.close();local.close();
  });
}
