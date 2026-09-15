export function remoteD1(url,token){
  const endpoint=new URL('/query',url);
  if(endpoint.protocol!=='https:'||!token||token.length<32)throw new Error('D1 storage requires HTTPS and a strong token');
  async function batch(statements){
    const response=await fetch(endpoint,{method:'POST',redirect:'manual',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({statements}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('D1 storage unavailable');
    const body=await response.json();if(!Array.isArray(body.result))throw new Error('Invalid D1 response');return body.result;
  }
  return {prepare(sql){return {sql,params:[],bind(...params){return {...this,params};},async all(){return (await batch([this]))[0];}};},batch};
}
