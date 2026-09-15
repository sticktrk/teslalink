import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,Response as MFResponse,convertV4MiniflareOptions} from 'miniflare';
let script:string;const instances:Miniflare[]=[];const secret='relay-test-secret-at-least-32-characters';
before(async()=>{script=(await build({entryPoints:['src/storage-worker.ts'],bundle:true,format:'esm',platform:'browser',write:false})).outputFiles[0].text;});
after(async()=>{await Promise.all(instances.map(i=>i.dispose()));});
function fixture(reply:()=>MFResponse=()=>MFResponse.json({access_token:'test-access',expires_in:3600,scope:'vehicle_device_data',debug:'not forwarded'})){
 const calls:any[]=[];const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{STORAGE_TOKEN:secret},outboundService:async r=>{calls.push({url:r.url,headers:Object.fromEntries(r.headers),body:Object.fromEntries(new URLSearchParams(await r.text()))});return reply();}}));instances.push(mf);
 return {calls,request:(body:any,token=secret)=>mf.dispatchFetch('https://gateway.example/oauth/token',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})};
}
const partner={grant_type:'client_credentials',client_id:'test-client',client_secret:'test-secret',audience:'https://fleet-api.prd.na.vn.cloud.tesla.com',scope:'vehicle_device_data vehicle_location'};
test('auth relay requires its gateway secret and accepts only known OAuth parameters',async()=>{
 const f=fixture();assert.equal((await f.request(partner,'incorrect')).status,401);
 for(const body of [{...partner,audience:'https://attacker.example'},{...partner,url:'https://attacker.example'},{...partner,scope:'vehicle_cmds'},{...partner,grant_type:'password'}])assert.equal((await f.request(body)).status,400);
 assert.equal(f.calls.length,0);
});
test('auth relay forwards only to official Tesla token endpoint and keeps responses private',async()=>{
 const f=fixture();const r=await f.request(partner);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{access_token:'test-access',expires_in:3600,scope:'vehicle_device_data'});
 assert.equal(f.calls[0].url,'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token');assert.deepEqual(f.calls[0].body,partner);assert.equal(f.calls[0].headers.authorization,undefined);
});
test('authorization code callback is restricted; rotating refresh tokens are forwarded',async()=>{
 const f=fixture();const code={grant_type:'authorization_code',client_id:'client',client_secret:'secret',audience:partner.audience,code:'code',redirect_uri:'https://tesla.dtconcepts.net/auth/callback'};
 assert.equal((await f.request({...code,redirect_uri:'https://attacker.example'})).status,400);assert.equal((await f.request(code)).status,200);
 assert.equal((await f.request({grant_type:'refresh_token',client_id:'client',refresh_token:'refresh'})).status,200);
});
test('edge HTML and redirects never leak; Tesla rate-limit headers survive',async()=>{
 const edge=fixture(()=>new MFResponse('<html>private edge reference</html>',{status:403,headers:{'Content-Type':'text/html'}}));const response=await edge.request(partner);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'tesla_edge_denied'});
 const redirect=fixture(()=>new MFResponse(null,{status:302,headers:{Location:'https://attacker.example'}}));assert.equal((await redirect.request(partner)).status,502);assert.equal(redirect.calls.length,1);
 const rate=fixture(()=>MFResponse.json({error:'rate_limited'},{status:429,headers:{'Retry-After':'120','Set-Cookie':'private'}}));const limited=await rate.request(partner);assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'120');assert.equal(limited.headers.get('set-cookie'),null);
});
