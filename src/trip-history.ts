import type { Records } from './records';
import { deriveTrips, type TripEvent } from './trips';
import { HttpError } from './security';

export async function tripHistory(records:Records,vin:string,url:URL,now=Date.now()) {
  const from=Number(url.searchParams.get('from')), to=Number(url.searchParams.get('to'));
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<1577836800000||to<=from||to-from>90000000||to>now+86400000)throw new HttpError(400,'Choose a trip window of up to 25 hours using Unix milliseconds.');
  // Context joins trips across midnight. Very long trips at the boundary remain explicitly partial.
  const start=from-6*3600000, end=Math.min(to+6*3600000,now);
  const rows:TripEvent[]=[];let timestamp=start,seq=0,complete=false;
  for(let page=0;page<20;page++){
    const batch=await records.query<any>(`SELECT id,seq,field,value,timestamp,timestamp_source FROM events WHERE vin=? AND kind='signal' AND field IN ('Gear','VehicleSpeed','Location','Odometer','Soc','BatteryLevel') AND timestamp>=? AND timestamp<=? AND (timestamp>? OR (timestamp=? AND seq>?)) AND LENGTH(value)<=512 ORDER BY timestamp,seq LIMIT 5000`,vin,start,end,timestamp,timestamp,seq);
    rows.push(...batch.map(e=>({...e,value:JSON.parse(e.value)})));
    if(batch.length<5000){complete=true;break;}
    timestamp=batch.at(-1).timestamp;seq=batch.at(-1).seq;
  }
  const boundary=complete?end:timestamp;
  return {from,to,scanned:rows.length,truncated:!complete,trips:deriveTrips(rows,now,boundary).filter(t=>t.startAt<to&&t.lastAt>=from).reverse(),contextHours:6};
}
