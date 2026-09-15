import type { TelemetryEvent } from './telemetry';
export type Statement = { sql: string; params: any[] };
export class Records {
  constructor(private local: SqlStorage, private transaction: <T>(fn:()=>T)=>T, private remote?: D1Database) {}
  async query<T=any>(sql: string, ...params: any[]): Promise<T[]> {
    if (this.remote) return (await this.remote.prepare(sql).bind(...params).all<T>()).results;
    return this.local.exec(sql,...params).toArray() as T[];
  }
  async batch(statements: Statement[]): Promise<any[][]> {
    if(this.remote) return (await this.remote.batch(statements.map(s=>this.remote!.prepare(s.sql).bind(...s.params)))).map(r=>r.results);
    return this.transaction(()=>statements.map(s=>this.local.exec(s.sql,...s.params).toArray()));
  }
  async ingest(events: TelemetryEvent[], receivedAt: number) {
    let accepted=0;
    // Keep each D1 request below the free-plan subrequest budget.
    for(let offset=0;offset<events.length;offset+=20){
      const statements: Statement[]=[];
      for(const e of events.slice(offset,offset+20)){
        const parsed=typeof e.value==='number'||(typeof e.value==='string'&&e.value.trim()!=='')?Number(e.value):NaN;
        statements.push({sql:'INSERT OR IGNORE INTO events(id,vin,kind,field,value,timestamp,timestamp_source,received_at,numeric_value) VALUES(?,?,?,?,?,?,?,?,?) RETURNING seq',params:[e.id,e.vin,e.kind,e.field,JSON.stringify(e.value),e.timestamp,e.timestampSource,receivedAt,Number.isFinite(parsed)?parsed:null]});
        // Read the committed event rather than caller values: duplicate IDs cannot alter cached signals.
        statements.push({sql:"INSERT INTO signals(vin,field,value,timestamp,timestamp_source) SELECT vin,CASE WHEN kind='connectivity' THEN '_connectivity' ELSE field END,value,timestamp,timestamp_source FROM events WHERE id=? AND kind IN ('signal','connectivity') ON CONFLICT(vin,field) DO UPDATE SET value=excluded.value,timestamp=excluded.timestamp,timestamp_source=excluded.timestamp_source WHERE excluded.timestamp>=signals.timestamp",params:[e.id]});
      }
      const results=await this.batch(statements);
      for(let i=0;i<results.length;i+=2)accepted+=results[i].length;
    }
    return accepted;
  }
}
