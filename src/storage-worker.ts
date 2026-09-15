import { equalSecret, readJson } from './security';
interface StorageEnv { DB:D1Database; STORAGE_TOKEN:string }
export default {
  async fetch(request:Request,env:StorageEnv):Promise<Response>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    if(request.method!=='POST'||new URL(request.url).pathname!=='/query')return Response.json({error:'Not found'},{status:404,headers});
    if(!env.STORAGE_TOKEN||env.STORAGE_TOKEN.length<32||!await equalSecret(request.headers.get('authorization')||'',`Bearer ${env.STORAGE_TOKEN}`))return Response.json({error:'Unauthorized'},{status:401,headers});
    try{
      const body=await readJson(request,1048576);
      if(!Array.isArray(body?.statements)||body.statements.length<1||body.statements.length>45)throw new Error('Invalid statements');
      const statements=body.statements.map((s:any)=>{
        if(typeof s?.sql!=='string'||s.sql.length>10000||!Array.isArray(s.params)||s.params.length>50||!/^(SELECT|INSERT|DELETE|UPDATE)\s/i.test(s.sql.trim()))throw new Error('Invalid statement');
        return env.DB.prepare(s.sql).bind(...s.params);
      });
      const result=await env.DB.batch(statements);
      return Response.json({result:result.map(r=>({results:r.results,meta:r.meta}))},{headers});
    }catch{return Response.json({error:'Storage operation failed'},{status:503,headers});}
  },
} satisfies ExportedHandler<StorageEnv>;
