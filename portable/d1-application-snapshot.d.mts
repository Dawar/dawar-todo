export type SnapshotTable = { name:string; rows:number; sha256:string };
export function captureD1Application(db:{ prepare(sql:string):{ all():Promise<unknown> } },signal?:AbortSignal):Promise<{
  snapshot:string; sha256:string; bytes:number; tables:SnapshotTable[];
  consistentRead:'single-sqlite-statement'; productionWriterFreezeEstablished:false;
}>;
