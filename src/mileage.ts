import { HttpError } from './security';
import { tripHistory } from './trip-history';
import { meters, type Trip, type RoutePoint } from './trips';
import type { Records } from './records';

export const JERSEY_PURPOSE = 'accounting, clerical, guidance, and technical work.';
export type Place = { id:'home'|'miami'|'jersey'; name:string; address:string; latitude:number; longitude:number; radius:number; source?:string };
export type MileageSettings = { enabled:boolean; places:Place[]; repos:string[]; authors:string[]; version:number; updatedAt:number };
export type Activity = { id:string; repo:string; kind:'commit'|'pr'; at:number; title:string; url:string; author:string };
export type MileageTrip = Omit<Trip,'points'> & { vin:string; first:RoutePoint|null; last:RoutePoint|null; from:Place|null; to:Place|null; classification:'Business'|'Unclassified'; client:string|null; purpose:string|null; evidence:Activity[]; flags:string[]; ruleVersion:number; window:{from:number|null;to:number}|null; superseded?:boolean };
const DAY=86400000;
export function validateSettings(input:any, version:number):MileageSettings {
  if(typeof input?.enabled!=='boolean'||!Array.isArray(input.places)||input.places.length!==3)throw new HttpError(400,'Configure exactly three places.');
  const ids=new Set();
  const places=input.places.map((p:any)=>{
    if(!['home','miami','jersey'].includes(p.id)||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>100||typeof p.address!=='string'||!p.address.trim()||p.address.length>250||!Number.isFinite(p.latitude)||Math.abs(p.latitude)>85||!Number.isFinite(p.longitude)||Math.abs(p.longitude)>180||!Number.isFinite(p.radius)||p.radius<25||p.radius>500)throw new HttpError(400,'Each place needs a name, address, valid coordinates, and a radius of 25–500 meters.');
    ids.add(p.id);return {id:p.id,name:p.name.trim(),address:p.address.trim(),latitude:p.latitude,longitude:p.longitude,radius:p.radius,source:typeof p.source==='string'?p.source.slice(0,200):'Owner configured'};
  });
  if(!Array.isArray(input.repos)||input.repos.length!==2||new Set(input.repos).size!==2||input.repos.some((r:any)=>typeof r!=='string'||! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)))throw new HttpError(400,'Provide two GitHub owner/repository names.');
  if(!Array.isArray(input.authors)||!input.authors.length||input.authors.length>10||input.authors.some((a:any)=>typeof a!=='string'||! /^[A-Za-z0-9-]{1,39}$/.test(a)))throw new HttpError(400,'Provide GitHub author usernames.');
  return {enabled:input.enabled,places,repos:input.repos,authors:input.authors,version,updatedAt:Date.now()};
}
export function matchPlace(point:RoutePoint|null,places:Place[]):Place|null {
  if(!point)return null;
  const hits=places.filter(p=>meters(point,{...p,timestamp:0,segment:0})<=p.radius);
  return hits.length===1?hits[0]:null; // Overlapping areas require configuration correction, never guess.
}
export function classifyTrips(input:Array<Trip & {vin:string}>, settings:MileageSettings, activities:Activity[], coverage:{from:number;to:number;complete:boolean}|null, observedAt:number):MileageTrip[] {
  const rows: MileageTrip[]=input.map(t=>{const {points,...data}=t;const first=points[0]||null,last=points.at(-1)||null;
    const from=first&&Math.abs(first.timestamp-t.startAt)<=120000?matchPlace(first,settings.places):null;
    const to=last&&t.endAt&&Math.abs(last.timestamp-t.endAt)<=300000?matchPlace(last,settings.places):null;
    const business=settings.enabled&&t.state==='completed'&&from&&to&&from.id!==to.id&&(from.id!=='home'||to.id!=='home');
    const client=business?(to!.id!=='home'?to!.id:from!.id):null;
    const flags:string[]=[];if(t.state!=='completed')flags.push('Incomplete trip');if(!from||!to)flags.push('Unmatched or stale endpoint');if(t.distanceMiles===null)flags.push('Missing distance');if(t.distanceSource==='gps')flags.push('GPS distance estimate');if(t.hasRouteGaps||t.rejectedPoints)flags.push('Route evidence gaps');if(t.startInferred)flags.push('Trip start inferred');
    return {...data,first,last,from,to,classification:business?'Business':'Unclassified',client,purpose:client==='jersey'?JERSEY_PURPOSE:null,evidence:[],flags,ruleVersion:settings.version,window:null};});
  // Visits are reconstructed independently of classification; an arrival from an unknown place still establishes a visit.
  for(const vin of new Set(rows.map(t=>t.vin))){
    const vehicle=rows.filter(t=>t.vin===vin).sort((a,b)=>a.startAt-b.startAt);
    const visits:Array<{arrival:number;departure:number|null;incoming:string;outgoing:string|null}>=[];
    for(const t of vehicle){
      if(t.from?.id==='miami'&&t.to?.id!=='miami'&&t.state==='completed'&&visits.length&&visits.at(-1)!.departure===null){visits.at(-1)!.departure=t.startAt;visits.at(-1)!.outgoing=t.id;}
      if(t.to?.id==='miami'&&t.state==='completed'&&t.endAt&&t.from?.id!=='miami')visits.push({arrival:t.endAt,departure:null,incoming:t.id,outgoing:null});
    }
    for(const t of vehicle.filter(t=>t.client==='miami')){
      const i=visits.findIndex(v=>v.incoming===t.id||v.outgoing===t.id),visit=visits[i];
      const previous=i>0?visits[i-1]:null;
      const from=previous?.departure??previous?.arrival??null,to=visit?(visit.departure??Math.min(observedAt,coverage?.to||observedAt)):t.startAt;
      t.window={from,to};
      if(from===null){t.flags.push('Previous visit not recorded — purpose pending');continue;}
      t.evidence=activities.filter(a=>settings.repos.includes(a.repo)&&settings.authors.includes(a.author)&&a.at>from&&a.at<=to).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
      if(!coverage?.complete||coverage.from>from||coverage.to<to)t.flags.push('GitHub coverage incomplete');
      if(!visit?.departure)t.flags.push('Visit still open — purpose provisional');
      if(!t.evidence.length){t.flags.push('No GitHub activity — purpose pending');continue;}
      const titles=[...new Set(t.evidence.map(a=>a.title))];
      t.purpose='Client software work — '+titles.slice(0,8).join('; ')+(titles.length>8?`; plus ${titles.length-8} additional activity item(s), listed in evidence.`:'.');
    }
  }
  return rows;
}

export class Mileage {
  private running:Promise<unknown>|null=null;
  constructor(private sql:SqlStorage,private records:Records){
    sql.exec(`CREATE TABLE IF NOT EXISTS mileage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mileage_trips(vin TEXT NOT NULL,id TEXT NOT NULL,start_at INTEGER NOT NULL,raw TEXT NOT NULL,data TEXT NOT NULL,updated_at INTEGER NOT NULL,superseded INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(vin,id));
      CREATE INDEX IF NOT EXISTS mileage_trip_date ON mileage_trips(vin,start_at);
      CREATE TABLE IF NOT EXISTS mileage_revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,vin TEXT NOT NULL,trip_id TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mileage_activity(id TEXT PRIMARY KEY,at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mileage_reports(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,data TEXT NOT NULL);`);
  }
  get<T>(key:string,fallback:T):T {const r=this.sql.exec<{value:string}>('SELECT value FROM mileage_meta WHERE key=?',key).toArray()[0];return r?JSON.parse(r.value):fallback;}
  set(key:string,value:unknown){this.sql.exec('INSERT INTO mileage_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
  settings(){return this.get<MileageSettings|null>('settings',null);}
  configure(input:any){const settings=validateSettings(input,(this.settings()?.version||0)+1);this.set(`settings:${settings.version}`,settings);this.set('settings',settings);this.reclassify();return settings;}
  ingestGithub(body:any){
    const settings=this.settings();if(!settings)throw new HttpError(409,'Configure mileage first.');
    if(!Array.isArray(body.activities)||body.activities.length>100||!Number.isSafeInteger(body.from)||!Number.isSafeInteger(body.to)||body.from<1577836800000||body.to<body.from||body.to>Date.now()+60000||typeof body.complete!=='boolean')throw new HttpError(400,'Invalid GitHub activity batch.');
    const valid:Activity[]=body.activities.map((a:any)=>{
      if(!settings.repos.includes(a.repo)||!settings.authors.includes(a.author)||!['commit','pr'].includes(a.kind)||typeof a.id!=='string'||a.id.length>200||!Number.isSafeInteger(a.at)||a.at<body.from||a.at>body.to||typeof a.title!=='string'||a.title.length>500||typeof a.url!=='string')throw new HttpError(400,'Invalid GitHub activity.');
      const prefix=`https://github.com/${a.repo}/${a.kind==='commit'?'commit':'pull'}/`;if(!a.url.startsWith(prefix)||! /^[a-zA-Z0-9]+$/.test(a.url.slice(prefix.length)))throw new HttpError(400,'Invalid GitHub evidence link.');
      return {id:a.id,repo:a.repo,kind:a.kind,at:a.at,title:a.title.replace(/[\x00-\x1f\x7f]/g,' ').trim(),url:a.url,author:a.author};
    });
    for(const a of valid)this.sql.exec('INSERT INTO mileage_activity VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,data=excluded.data',a.id,a.at,JSON.stringify(a));
    if(body.complete){this.set('githubCoverage',{from:body.from,to:body.to,complete:true});this.set('githubSyncAt',Date.now());this.reclassify();}
    return {accepted:valid.length};
  }
  private reclassify(){
    const settings=this.settings();if(!settings)return;
    const raw=this.sql.exec<{raw:string}>('SELECT raw FROM mileage_trips WHERE superseded=0 ORDER BY start_at').toArray().map(r=>JSON.parse(r.raw));
    const activities=this.sql.exec<{data:string}>('SELECT data FROM mileage_activity ORDER BY at').toArray().map(r=>JSON.parse(r.data));
    for(const record of classifyTrips(raw,settings,activities,this.get('githubCoverage',null),Date.now())){
      const data=JSON.stringify(record),old=this.sql.exec<{data:string}>('SELECT data FROM mileage_trips WHERE vin=? AND id=?',record.vin,record.id).toArray()[0];
      if(old?.data===data)continue;
      this.sql.exec('UPDATE mileage_trips SET data=?,updated_at=? WHERE vin=? AND id=?',data,Date.now(),record.vin,record.id);
      this.sql.exec('INSERT INTO mileage_revisions(vin,trip_id,at,data) VALUES(?,?,?,?)',record.vin,record.id,Date.now(),data);
    }
  }
  async sync(){
    if(this.running)return this.running;
    this.running=this.syncWork().finally(()=>{this.running=null;});return this.running;
  }
  private async syncWork(){
    if(!this.settings()?.enabled)return {enabled:false};
    const now=Date.now(),today=Math.floor(now/DAY)*DAY;
    this.set('syncWarning',null);
    for(const {vin} of this.sql.exec<{vin:string}>('SELECT vin FROM vehicles WHERE active=1').toArray()){
      const earliest=(await this.records.query<{timestamp:number}>('SELECT timestamp FROM events WHERE vin=? ORDER BY timestamp LIMIT 1',vin))[0]?.timestamp;
      if(!earliest)continue;
      let cursor=this.get<number>(`cursor:${vin}`,Math.floor(earliest/DAY)*DAY);
      const dates=new Set([today-DAY,today]);
      const lastReceived=this.get<number>(`received:${vin}`,now);
      const changed=await this.records.query<{day:number}>('SELECT DISTINCT CAST(timestamp/86400000 AS INTEGER)*86400000 AS day FROM events WHERE vin=? AND received_at>=?',vin,lastReceived);
      for(const d of changed)dates.add(d.day);
      for(let n=0;n<2&&cursor<today-DAY;n++,cursor+=DAY)dates.add(cursor);
      for(const from of [...dates].sort()){
        const to=Math.min(from+DAY,now);if(to<=from)continue;
        const result=await tripHistory(this.records,vin,new URL(`https://local/trips?from=${from}&to=${to}`),now);
        if(result.truncated){cursor=Math.min(cursor,from);this.set('syncWarning','Trip scan limit reached; mileage history is incomplete.');continue;}
        const ids=new Set(result.trips.map(t=>t.id));
        for(const old of this.sql.exec<{id:string,data:string}>('SELECT id,data FROM mileage_trips WHERE vin=? AND start_at>=? AND start_at<? AND superseded=0',vin,from,to).toArray())if(!ids.has(old.id)){
          this.sql.exec('UPDATE mileage_trips SET superseded=1 WHERE vin=? AND id=?',vin,old.id);
          this.sql.exec('INSERT INTO mileage_revisions(vin,trip_id,at,data) VALUES(?,?,?,?)',vin,old.id,now,JSON.stringify({...JSON.parse(old.data||'{}'),superseded:true}));
        }
        for(const t of result.trips){
          if(t.startAt<from||t.startAt>=to)continue;
          this.sql.exec('INSERT INTO mileage_trips(vin,id,start_at,raw,data,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(vin,id) DO UPDATE SET start_at=excluded.start_at,raw=excluded.raw,superseded=0',vin,t.id,t.startAt,JSON.stringify({...t,vin}),'{}',now);
        }
      }
      this.set(`cursor:${vin}`,cursor);
      this.set(`received:${vin}`,now);
    }
    this.reclassify();this.set('syncedAt',now);return {ok:true,syncedAt:now};
  }
  list(vin:string,from:number,to:number){
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<1577836800000||to<=from||to-from>370*DAY)throw new HttpError(400,'Choose a mileage period of up to one year.');
    const trips=this.sql.exec<{data:string,updated_at:number}>('SELECT data,updated_at FROM mileage_trips WHERE vin=? AND start_at>=? AND start_at<? AND superseded=0 ORDER BY start_at DESC',vin,from,to).toArray().map(r=>({...JSON.parse(r.data),updatedAt:r.updated_at}));
    return {from,to,trips,syncedAt:this.get('syncedAt',null),githubSyncAt:this.get('githubSyncAt',null),warning:this.get('syncWarning',null)};
  }
  report(vin:string,from:number,to:number,tripId?:string){
    const all=this.list(vin,from,to),trips=all.trips.filter(t=>t.classification==='Business'&&(!tripId||t.id===tripId));
    if(tripId&&!trips.length)throw new HttpError(404,'Business trip not found.');
    const id=crypto.randomUUID(),createdAt=Date.now();
    const data={id,createdAt,vin,from,to,trips,totalMiles:trips.reduce((n,t)=>n+(t.distanceMiles||0),0),excludedTrips:all.trips.length-trips.length,missingDistance:trips.filter(t=>t.distanceMiles===null).length,settings:this.settings(),githubSyncAt:all.githubSyncAt,syncedAt:all.syncedAt,warning:all.warning};
    this.sql.exec('INSERT INTO mileage_reports VALUES(?,?,?)',id,createdAt,JSON.stringify(data));return data;
  }
}
