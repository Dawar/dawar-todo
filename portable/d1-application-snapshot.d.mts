export type SnapshotTable = { name:string; rows:number; sha256:string };
export function probeD1Application(db:{ prepare(sql:string):{ all():Promise<unknown> } },signal?:AbortSignal):Promise<{
  version:1;kind:'dawar-snapshot-compatibility';supported:Record<string,boolean>;applicationDataReturned:false;writerFreezeEstablished:false;
}>;
export function captureD1Application(db:{ prepare(sql:string):{ all():Promise<unknown> } },signal?:AbortSignal):Promise<{
  snapshot:string; sha256:string; bytes:number; tables:SnapshotTable[];
  consistentRead:'single-sqlite-statement'; productionWriterFreezeEstablished:false;
}>;
