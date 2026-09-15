import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveTrips,gearValue,meters,type TripEvent} from '../src/trips';
const base=Date.UTC(2026,8,15,12);
const event=(seconds:number,field:string,value:any,id=`${seconds}-${field}`):TripEvent=>({id,seq:seconds*10,field,value,timestamp:base+seconds*1000,timestamp_source:'receiver'});
const position=(lat:number,lon=-78)=>({latitude:lat,longitude:lon});
const drive=[event(0,'Odometer',100),event(0,'Soc',80),event(0,'Gear','ShiftStateD'),event(0,'Location',position(36)),event(10,'VehicleSpeed',30),event(30,'Location',position(36.003)),event(60,'Location',position(36.006)),event(60,'Odometer',100.5),event(60,'Soc',79),event(60,'Gear','ShiftStateP')];
test('trip detects Drive → Park, miles, battery, route and receiver timestamps',()=>{
 const [t]=deriveTrips(drive,base+120000);assert.equal(t.state,'completed');assert.equal(t.distanceMiles,0.5);assert.equal(t.distanceSource,'odometer');assert.equal(t.durationSeconds,60);assert.equal(t.maxSpeedMph,30);assert.equal(t.startBattery,80);assert.equal(t.endBattery,79);assert.equal(t.points.length,3);assert.equal(t.receiverTimestamps,true);assert.equal(t.startInferred,false);
});
test('out-of-order input and duplicate event IDs reconstruct the same trip',()=>{
 assert.deepEqual(deriveTrips([...drive].reverse().concat(drive),base+120000),deriveTrips(drive,base+120000));
});
test('parking GPS drift and waking up do not create trips',()=>{
 assert.equal(deriveTrips([event(0,'Gear','P'),event(0,'Location',position(36)),event(60,'Location',position(36.0008)),event(120,'Soc',80)],base+200000).length,0);
 assert.equal(deriveTrips([event(0,'Gear','D'),event(30,'Gear','P')],base+60000).length,0);
});
test('GPS-only movement accumulates small steps and uses GPS distance',()=>{
 const points=Array.from({length:15},(_,i)=>event(i*10,'Location',position(36+i*0.0001)));
 const [trip]=deriveTrips(points,base+160000);assert.equal(trip.state,'active');assert.equal(trip.startInferred,true);assert.equal(trip.distanceSource,'gps');assert.ok(trip.distanceMiles!>0.08);
});
test('traffic light pauses and reverse remain one trip until park',()=>{
 const t=deriveTrips([event(0,'Gear',3),event(2,'VehicleSpeed',-3),event(10,'Gear',5),event(20,'VehicleSpeed',25),event(30,'VehicleSpeed',0),event(100,'VehicleSpeed',25),event(120,'Gear',2)],base+140000);
 assert.equal(t.length,1);assert.equal(t[0].durationSeconds,120);assert.equal(t[0].maxSpeedMph,25);
});
test('telemetry outages split trips and never invent a parked end',()=>{
 const t=deriveTrips([event(0,'VehicleSpeed',25),event(30,'Location',position(36)),event(1500,'VehicleSpeed',20)],base+1510000);
 assert.equal(t.length,2);assert.equal(t[0].endReason,'telemetry_gap');assert.equal(t[0].state,'incomplete');assert.equal(t[1].state,'active');
});
test('impossible GPS jumps are excluded without poisoning the next point',()=>{
 const [t]=deriveTrips([...drive,event(20,'Location',position(0,0))],base+120000);assert.equal(t.rejectedPoints,1);assert.equal(t.points.length,3);assert.ok(t.gpsDistanceMiles<1);
});
test('missing GPS segments are not joined into a fictional straight-line distance',()=>{
 const [t]=deriveTrips([event(0,'Gear','D'),event(0,'Location',position(36)),event(10,'VehicleSpeed',30),event(180,'Location',position(36.1)),event(190,'Gear','P')],base+200000);
 assert.equal(t.hasRouteGaps,true);assert.equal(t.points[1].segment,1);assert.equal(t.gpsDistanceMiles,0);
});
test('null and invalid locations are not converted to 0,0; valid zeros are retained',()=>{
 const [t]=deriveTrips([event(0,'Gear','D'),event(1,'VehicleSpeed',15),event(2,'Location',{latitude:null,longitude:null}),event(3,'Location',{invalid:true}),event(4,'Location',position(0,0)),event(10,'Gear','P')],base+20000);
 assert.equal(t.points.length,1);assert.equal(t.points[0].latitude,0);assert.equal(t.distanceMiles,null);
});
test('window boundaries are marked incomplete and midnight itself does not split trips',()=>{
 const [t]=deriveTrips(drive.slice(0,-1),base+86400000,base+60000);assert.equal(t.endReason,'window_boundary');
 const overnight=drive.map(e=>({...e,timestamp:e.timestamp+12*3600000-30000}));assert.equal(deriveTrips(overnight,base+13*3600000).length,1);
});
test('odometer reset falls back to GPS; missing speed remains unknown',()=>{
 const [t]=deriveTrips(drive.filter(e=>e.field!=='VehicleSpeed').map(e=>e.field==='Odometer'&&e.timestamp>base?{...e,value:1}:e),base+120000);assert.equal(t.distanceSource,'gps');assert.equal(t.maxSpeedMph,null);
});
test('numeric and named Tesla gears and antimeridian distances are supported',()=>{
 assert.equal(gearValue('ShiftStateD'),'D');assert.equal(gearValue(2),'P');assert.equal(gearValue('ShiftStateInvalid'),null);
 assert.ok(meters({latitude:0,longitude:179.999,timestamp:0,segment:0},{latitude:0,longitude:-179.999,timestamp:1,segment:0})<300);
});
