import { HttpError, readJson } from './security';
import { API_HOSTS, TOKEN_URL } from './telemetry';

/** Fixed-destination OAuth exchange, reachable only with the server's gateway secret. */
export async function relayTeslaAuth(request:Request):Promise<Response>{
  const body=await readJson(request,8192);
  const grants:Record<string,string[]>={client_credentials:['grant_type','client_id','client_secret','audience','scope'],authorization_code:['grant_type','client_id','client_secret','audience','redirect_uri','code'],refresh_token:['grant_type','client_id','refresh_token']};
  const allowed=grants[body?.grant_type];
  if(!Array.isArray(allowed)||Object.keys(body).some(k=>!allowed.includes(k))||Object.values(body).some(v=>typeof v!=='string')||!body.client_id)throw new HttpError(400,'Invalid OAuth request.');
  if(body.grant_type!=='refresh_token'&&(!body.client_secret||!Object.values(API_HOSTS).includes(body.audience)))throw new HttpError(400,'Invalid OAuth audience or credentials.');
  if(body.grant_type==='authorization_code'&&(!body.code||body.redirect_uri!=='https://tesla.dtconcepts.net/auth/callback'))throw new HttpError(400,'Invalid OAuth callback.');
  if(body.grant_type==='refresh_token'&&!body.refresh_token)throw new HttpError(400,'Missing refresh token.');
  if(body.scope&&body.scope.split(' ').some((s:string)=>!['openid','offline_access','vehicle_device_data','vehicle_location'].includes(s)))throw new HttpError(400,'Invalid OAuth scope.');
  const response=await fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),redirect:'manual',signal:AbortSignal.timeout(20000)});
  const headers=new Headers({'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'});
  // Preserve backoff, but never forward redirects, cookies, or arbitrary edge HTML.
  for(const [key,value] of response.headers)if(key==='retry-after'||/^ratelimit-.*-reset$/i.test(key))headers.set(key,value);
  if(response.status>=300&&response.status<400)return Response.json({error:'unexpected_auth_redirect'},{status:502,headers});
  let data:any;try{data=await response.json();}catch{return Response.json({error:response.status===403?'tesla_edge_denied':'invalid_auth_response'},{status:response.status>=400?response.status:502,headers});}
  const filtered=Object.fromEntries(['access_token','refresh_token','expires_in','token_type','scope','error'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]]));
  return Response.json(filtered,{status:response.status,headers});
}
