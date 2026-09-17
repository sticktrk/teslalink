import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {classifyTrips,validateSettings,JERSEY_PURPOSE,Mileage,type Activity,type MileageSettings} from '../src/mileage.ts';
import type {Trip} from '../src/trips.ts';
const base=1789500000000;
const settings: MileageSettings=validateSettings({enabled:true,places:[{id:'home',name:'Home',address:'Home address',latitude:35,longitude:-78,radius:100},{id:'miami',name:'Miami',address:'Miami address',latitude:35.1,longitude:-78,radius:100},{id:'jersey',name:'Jersey',address:'Jersey address',latitude:35.2,longitude:-78,radius:100}],repos:['owner/one','owner/two'],authors:['owner']},1);
function trip(id:string,from:string,to:string,hour:number):Trip&{vin:string}{const startAt=base+hour*3600000,endAt=startAt+600000;const point=(id:string,timestamp:number)=>({...settings.places.find(p=>p.id===id)!,timestamp,segment:0});return {vin:'V',id,startAt,lastAt:endAt,endAt,state:'completed',endReason:'parked',startInferred:false,durationSeconds:600,distanceMiles:5,distanceSource:'odometer',gpsDistanceMiles:5,maxSpeedMph:45,startBattery:80,endBattery:78,points:[point(from,startAt),point(to,endAt)],rejectedPoints:0,hasRouteGaps:false,receiverTimestamps:true};}
const coverage={from:base-86400000,to:base+86400000,complete:true};
test('direct saved-place trips classify automatically; Jersey purpose is exact in both directions',()=>{
 const result=classifyTrips([trip('a','home','jersey',1),trip('b','jersey','home',2),trip('c','miami','jersey',3)],settings,[],coverage,coverage.to);
 assert.ok(result.every(t=>t.classification==='Business'&&t.purpose===JERSEY_PURPOSE));
});
test('unknown endpoints, pass-throughs, incomplete trips and overlapping zones never trigger business',()=>{
 const unknown=trip('a','home','jersey',1);unknown.points.at(-1)!.latitude=36;
 const incomplete={...trip('b','home','jersey',2),state:'incomplete' as const};
 const overlap={...settings,places:settings.places.map(p=>p.id==='miami'?{...p,latitude:35.2}:p)};
 assert.equal(classifyTrips([unknown,incomplete],settings,[],coverage,coverage.to).filter(t=>t.classification==='Business').length,0);
 assert.equal(classifyTrips([trip('c','home','jersey',3)],overlap,[],coverage,coverage.to)[0].classification,'Unclassified');
});
test('GitHub interval is previous departure through current departure and shared by inbound/return legs',()=>{
 const trips=[trip('a','home','miami',1),trip('b','miami','home',2),trip('c','home','miami',5),trip('d','miami','home',8)];
 const activity=(id:string,hour:number):Activity=>({id,repo:'owner/one',kind:'commit',at:base+hour*3600000,title:'Correct intake validation',url:'https://github.com/owner/one/commit/abc',author:'owner'});
 const rows=classifyTrips(trips,settings,[activity('old',1),activity('between',4),activity('onsite',7),activity('future',9)],coverage,coverage.to);
 assert.equal(rows[0].purpose,null);assert.ok(rows[0].flags.some(f=>f.includes('Previous visit')));
 assert.deepEqual(rows[2].evidence.map(a=>a.id),['between','onsite']);assert.equal(rows[2].purpose,rows[3].purpose);assert.deepEqual(rows[2].window,{from:base+2*3600000,to:base+8*3600000});
});
test('missing GitHub evidence preserves business and adds a purpose flag; first visit is not invented',()=>{
 const rows=classifyTrips([trip('a','home','miami',1),trip('b','miami','home',2),trip('c','home','miami',5)],settings,[],null,coverage.to);
 assert.equal(rows[2].classification,'Business');assert.equal(rows[2].purpose,null);assert.ok(rows[2].flags.includes('No GitHub activity — purpose pending'));
});
test('settings reject invalid coordinates and duplicated place IDs',()=>{
 assert.throws(()=>validateSettings({...settings,places:settings.places.map(p=>({...p,id:'home'}))},2));
 assert.throws(()=>validateSettings({...settings,places:settings.places.map(p=>({...p,latitude:NaN}))},2));
});
test('saved reports are immutable and source updates create record revisions',()=>{
 const db=new DatabaseSync(':memory:');const sql={exec(query:string,...params:any[]){if(!params.length&&query.split(';').filter(s=>s.trim()).length>1){db.exec(query);return {toArray:()=>[]};}const rows=db.prepare(query).all(...params);return {toArray:()=>rows};}};
 const service=new Mileage(sql as any,{} as any);service.configure(settings);
 const t=trip('a','home','jersey',1);db.prepare('INSERT INTO mileage_trips VALUES(?,?,?,?,?,?,0)').run('V',t.id,t.startAt,JSON.stringify(t),'{}',base);
 service.configure(settings);const first=service.report('V',base,base+86400000);assert.equal(first.totalMiles,5);assert.equal(first.trips[0].purpose,JERSEY_PURPOSE);
 service.configure({...settings,enabled:false});assert.equal(service.list('V',base,base+86400000).trips[0].classification,'Unclassified');assert.equal(JSON.parse(db.prepare('SELECT data FROM mileage_reports WHERE id=?').get(first.id)!.data as string).totalMiles,5);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM mileage_revisions').get()!.n,2);
 assert.throws(()=>service.ingestGithub({from:base,to:base+86400000,complete:true,activities:[{id:'x',repo:'owner/one',kind:'commit',author:'owner',at:base,title:'x',url:'https://evil.example/steal'}]}));db.close();
});
