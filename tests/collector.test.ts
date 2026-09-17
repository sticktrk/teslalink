import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
for(const failure of [false,true])test(`GitHub collector ${failure?'does not publish coverage after failure':'publishes bounded metadata and then synchronizes mileage'}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tesla-collector-test-')),posts:any[]=[];
 writeFileSync(join(dir,'gh'),`#!${process.execPath}\nif(process.env.COLLECTOR_TEST_FAIL==='yes')process.exit(1);\nconst endpoint=process.argv[3];const repo=endpoint.split('/').slice(1,3).join('/');const at=new Date(Date.now()-3600000).toISOString();console.log(JSON.stringify(endpoint.includes('/commits?')?[{sha:'abc',commit:{committer:{date:at},message:'Correct validation'}}]:[{number:1,merged_at:at,updated_at:at,title:'Client update',user:{login:'owner'}}]));`,{mode:0o700});
 const server=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;assert.equal(req.headers.authorization,'Bearer test-collector-token');res.setHeader('Content-Type','application/json');if(req.method==='GET')res.end(JSON.stringify({enabled:true,repos:['owner/one','owner/two'],authors:['owner']}));else{posts.push({path:req.url,data:JSON.parse(data)});res.end('{}');}});
 server.keepAliveTimeout=1;
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const run=promisify(execFile)(process.execPath,[resolve('scripts/collect-github.mjs')],{env:{...process.env,PATH:dir+':'+process.env.PATH,PORT:String((server.address() as any).port),APP_URL:'https://garage.example.com',INGEST_TOKEN:'test-collector-token',COLLECTOR_TEST_FAIL:failure?'yes':'no'},timeout:20000});
  if(failure){await assert.rejects(run);assert.equal(posts.length,0);}else{await run;assert.equal(posts[0].data.activities.length,4);assert.equal(posts[0].data.complete,false);assert.equal(posts[1].data.complete,true);assert.equal(posts[2].path,'/api/mileage/collector/sync');assert.ok(posts[0].data.activities.every((a:any)=>a.url.startsWith('https://github.com/owner/')));}
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
