// Runs as a systemd oneshot using the server's existing gh login. Tokens never enter the app.
import {execFileSync} from 'node:child_process';
import http from 'node:http';
const origin=new URL(process.env.APP_URL);
function app(path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({hostname:'127.0.0.1', port:Number(process.env.PORT||8788), path,
      method:body?'POST':'GET', headers:{Host:origin.host, Authorization:`Bearer ${process.env.INGEST_TOKEN}`, 'Content-Type':'application/json'}}, response => {
      let data='';
      response.on('data', chunk => data+=chunk);
      response.on('end', () => {
        if(response.statusCode!==200) return reject(new Error(`App HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid app response')); }
      });
    });
    request.setTimeout(120000, () => request.destroy(new Error('App timeout')));
    request.on('error', reject);
    request.end(body?JSON.stringify(body):undefined);
  });
}
function github(endpoint){return JSON.parse(execFileSync('gh',['api',endpoint,'-H','Accept: application/vnd.github+json'],{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']}));}
try{
 const config=await app('/api/mileage/collector');if(!config.enabled)process.exit(0);
 if(config.repos.length!==2||config.repos.some(r=>! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)))throw new Error('Invalid repository configuration');
 const to=Date.now(),from=to-90*86400000,items=new Map();
 for(const repo of config.repos){
  for(const author of config.authors){
   let complete=false;
   for(let page=1;page<=20;page++){
    const params=new URLSearchParams({author,since:new Date(from).toISOString(),until:new Date(to).toISOString(),per_page:'100',page:String(page)});
    const data=github(`repos/${repo}/commits?${params}`);if(!Array.isArray(data))throw new Error('Invalid commit response');
    for(const c of data){const at=Date.parse(c.commit?.committer?.date);if(at<from||at>to||!Number.isFinite(at))continue;const id=`${repo}:commit:${c.sha}`;items.set(id,{id,repo,kind:'commit',at,title:c.commit.message.split('\n')[0].slice(0,500),url:`https://github.com/${repo}/commit/${c.sha}`,author});}
    if(data.length<100){complete=true;break;}
   }
   if(!complete)throw new Error('Commit pagination exceeded; collection incomplete');
  }
  let complete=false;
  for(let page=1;page<=20;page++){
   const data=github(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);if(!Array.isArray(data))throw new Error('Invalid pull request response');
   for(const p of data){const at=Date.parse(p.merged_at);if(!Number.isFinite(at)||at<from||at>to||!config.authors.includes(p.user?.login))continue;const id=`${repo}:pr:${p.number}`;items.set(id,{id,repo,kind:'pr',at,title:p.title.slice(0,500),url:`https://github.com/${repo}/pull/${p.number}`,author:p.user.login});}
   if(data.length<100||Date.parse(data.at(-1)?.updated_at)<from){complete=true;break;}
  }
  if(!complete)throw new Error('Pull request pagination exceeded; collection incomplete');
 }
 const activities=[...items.values()];for(let i=0;i<activities.length;i+=100)await app('/api/mileage/collector',{from,to,complete:false,activities:activities.slice(i,i+100)});
 await app('/api/mileage/collector',{from,to,complete:true,activities:[]});
 await app('/api/mileage/collector/sync',{});
 console.log(`GitHub metadata synchronized: ${activities.length} activity items.`);
}catch(error){console.error('GitHub mileage collection failed; evidence remains flagged. '+(error.status?'GitHub access error.':error.message?.startsWith('Command failed')?'GitHub access or rate limit error.':error.message));process.exitCode=1;}
