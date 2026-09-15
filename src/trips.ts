/** Reconstruct trips from immutable telemetry. Late arrivals are included on the next read. */
export const TRIP_FIELDS = ['Gear', 'VehicleSpeed', 'Location', 'Odometer', 'Soc', 'BatteryLevel'];
export const TRIP_GAP_MS = 15 * 60000;
export type TripEvent = { id: string; seq: number; field: string; value: unknown; timestamp: number; timestamp_source: string };
export type RoutePoint = { latitude: number; longitude: number; timestamp: number; segment: number };
export type Trip = {
  id: string; startAt: number; lastAt: number; endAt: number | null;
  state: 'completed' | 'active' | 'incomplete'; endReason: 'parked' | 'telemetry_gap' | 'window_boundary' | null;
  startInferred: boolean; durationSeconds: number; distanceMiles: number | null;
  distanceSource: 'odometer' | 'gps' | null; gpsDistanceMiles: number; maxSpeedMph: number | null;
  startBattery: number | null; endBattery: number | null; points: RoutePoint[];
  rejectedPoints: number; hasRouteGaps: boolean; receiverTimestamps: boolean;
};
const numeric = (v: unknown): number | null => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v) : null;
export function gearValue(v: unknown): string | null {
  if (typeof v === 'number') return ({2:'P',3:'R',4:'N',5:'D'} as Record<number,string>)[v] || null;
  const gear = typeof v === 'string' ? v.replace(/^ShiftState/, '').toUpperCase() : '';
  return ['P','R','N','D'].includes(gear) ? gear : null;
}
function location(v: any, timestamp: number): RoutePoint | null {
  if (!v || typeof v !== 'object' || v.invalid) return null;
  const latitude=numeric(v.latitude ?? v.Latitude), longitude=numeric(v.longitude ?? v.Longitude);
  if(latitude===null||longitude===null||Math.abs(latitude)>90||Math.abs(longitude)>180)return null;
  return {latitude,longitude,timestamp,segment:0};
}
export function meters(a: RoutePoint, b: RoutePoint): number {
  const rad=Math.PI/180, dlat=(b.latitude-a.latitude)*rad, dlon=(b.longitude-a.longitude)*rad;
  const h=Math.sin(dlat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dlon/2)**2;
  return 6371000*2*Math.asin(Math.min(1,Math.sqrt(h)));
}
type Reading = {value:number;at:number};
type Working = Trip & {moved:boolean;lastEvidence:number;odoStart:Reading|null;odoEnd:Reading|null;gpsMeters:number};
export function deriveTrips(input: TripEvent[], observedAt=Date.now(), boundaryAt=observedAt): Trip[] {
  // Park is applied after the last position at the same timestamp; starting gear comes first.
  const priority=(e:TripEvent)=>e.field==='Gear'?(gearValue(e.value)==='P'?3:1):['Soc','BatteryLevel','Odometer'].includes(e.field)?0:2;
  const events=[...input].sort((a,b)=>a.timestamp-b.timestamp||priority(a)-priority(b)||a.seq-b.seq);
  const seen=new Set<string>(), trips:Trip[]=[];
  const state: {active:Working|null} = {active:null};
  let gear:string|null=null, lastPoint:RoutePoint|null=null, odo:Reading|null=null, battery:Reading|null=null;
  const finish=(reason:Trip['endReason'],at:number)=>{
    if(!state.active)return;
    state.active.lastAt=Math.max(state.active.lastAt,at);
    state.active.endAt=reason?state.active.lastAt:null;
    state.active.endReason=reason;state.active.state=reason==='parked'?'completed':reason?'incomplete':'active';
    state.active.durationSeconds=Math.max(0,(state.active.lastAt-state.active.startAt)/1000);
    state.active.gpsDistanceMiles=state.active.gpsMeters/1609.344;
    const delta=state.active.odoStart&&state.active.odoEnd?state.active.odoEnd.value-state.active.odoStart.value:null;
    const covered=state.active.odoStart&&state.active.odoEnd&&state.active.odoStart.at<=state.active.startAt+60000&&state.active.odoEnd.at>=state.active.lastAt-60000;
    const validDelta=delta!==null&&delta>=0&&delta<=250*Math.max(state.active.durationSeconds,60)/3600+0.2&&(delta>0||state.active.gpsMeters<50);
    if(covered&&validDelta){state.active.distanceMiles=delta;state.active.distanceSource='odometer';}
    else if(state.active.points.length>=2&&state.active.gpsMeters>0){state.active.distanceMiles=state.active.gpsDistanceMiles;state.active.distanceSource='gps';}
    if(state.active.moved){const {moved,lastEvidence,odoStart,odoEnd,gpsMeters,...trip}=state.active;trips.push(trip);}
    state.active=null;
  };
  const begin=(e:TripEvent,inferred:boolean,seed:RoutePoint|null)=>{
    const start=inferred&&seed?seed.timestamp:e.timestamp;
    state.active={id:e.id,startAt:start,lastAt:e.timestamp,endAt:null,state:'active',endReason:null,startInferred:inferred,durationSeconds:0,distanceMiles:null,distanceSource:null,gpsDistanceMiles:0,maxSpeedMph:null,startBattery:battery&&start-battery.at<=300000?battery.value:null,endBattery:battery&&start-battery.at<=300000?battery.value:null,points:seed?[{...seed,segment:0}]:[],rejectedPoints:0,hasRouteGaps:false,receiverTimestamps:e.timestamp_source==='receiver',moved:false,lastEvidence:e.timestamp,odoStart:odo&&start-odo.at<=60000?odo:null,odoEnd:odo&&start-odo.at<=60000?odo:null,gpsMeters:0};
  };
  for(const e of events){
    if(seen.has(e.id)||!Number.isFinite(e.timestamp))continue;seen.add(e.id);
    if(state.active&&e.timestamp-state.active.lastEvidence>TRIP_GAP_MS){finish('telemetry_gap',state.active.lastEvidence);gear=null;lastPoint=null;odo=null;battery=null;}
    const n=numeric(e.value);
    if(e.field==='Soc'||e.field==='BatteryLevel'){
      if(n!==null&&n>=0&&n<=100){battery={value:n,at:e.timestamp};if(state.active){state.active.endBattery=n;if(state.active.startBattery===null&&e.timestamp-state.active.startAt<=60000)state.active.startBattery=n;}}
      continue;
    }
    if(e.field==='Odometer'){
      if(n!==null&&n>=0){odo={value:n,at:e.timestamp};if(state.active){state.active.odoStart??=odo;state.active.odoEnd=odo;if(state.active.odoStart&&n-state.active.odoStart.value>=0.03)state.active.moved=true;}}
      continue;
    }
    if(e.field==='Gear'){
      gear=gearValue(e.value);
      if(gear==='P'){finish('parked',e.timestamp);continue;}
      if(gear==='D'||gear==='R'){
        if(!state.active)begin(e,false,lastPoint&&e.timestamp-lastPoint.timestamp<=60000?lastPoint:null);
        state.active!.lastEvidence=e.timestamp;state.active!.lastAt=e.timestamp;
      }
    } else if(e.field==='VehicleSpeed'){
      if(n!==null&&Math.abs(n)<=250&&Math.abs(n)>1){
        if(!state.active)begin(e,true,lastPoint&&e.timestamp-lastPoint.timestamp<=60000?lastPoint:null);
        state.active!.moved=true;state.active!.lastEvidence=e.timestamp;state.active!.lastAt=e.timestamp;
        state.active!.maxSpeedMph=Math.max(state.active!.maxSpeedMph??0,Math.abs(n));
      }
    } else if(e.field==='Location'){
      const p=location(e.value,e.timestamp);if(!p)continue;
      const previous=lastPoint, dt=previous?p.timestamp-previous.timestamp:0, distance=previous?meters(previous,p):0;
      // Reject impossible jumps without poisoning the anchor for the next reading.
      if(previous&&dt<=120000&&(dt<=0?distance>30:distance>Math.max(50,dt/1000*112))){if(state.active)state.active.rejectedPoints++;continue;}
      if(!state.active&&gear!=='P'&&previous&&dt>0&&dt<=120000&&distance>=30)begin(e,true,previous);
      if(state.active||gear==='P'||!previous||distance>=30||dt>120000)lastPoint=p;
      if(state.active){
        const last=state.active.points.at(-1), step=last?meters(last,p):0;
        if(last&&p.timestamp-last.timestamp>120000){p.segment=last.segment+1;state.active.hasRouteGaps=true;}
        else {p.segment=last?.segment??0;if(last&&step>=10)state.active.gpsMeters+=step;}
        if(!last||step>=10||p.segment!==last.segment)state.active.points.push(p);
        if(distance>=30&&dt>0&&dt<=120000)state.active.moved=true;
        if(gear==='D'||gear==='R'||distance>=10){state.active.lastEvidence=e.timestamp;state.active.lastAt=e.timestamp;}
      }
    }
    if(state.active&&e.timestamp_source==='receiver')state.active.receiverTimestamps=true;
  }
  if(state.active){
    if(boundaryAt<observedAt-TRIP_GAP_MS&&boundaryAt-state.active.lastEvidence<TRIP_GAP_MS)finish('window_boundary',state.active.lastAt);
    else if(observedAt-state.active.lastEvidence>TRIP_GAP_MS)finish('telemetry_gap',state.active.lastEvidence);
    else finish(null,state.active.lastAt);
  }
  return trips;
}
