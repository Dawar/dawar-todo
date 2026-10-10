export type SourceWriterBinding = {sourceId:string;installationId:string;producerSHA256:string};
export type SourceWriterInput = {db:unknown;expected:SourceWriterBinding};
export function installSourceWriterAdmission(input:SourceWriterInput):Promise<unknown>;
export function admitSourceWriter(input:SourceWriterInput & {operationId:string;kind:'worker-http'|'worker-scheduled'}):Promise<unknown>;
export function settleSourceWriter(input:SourceWriterInput & {operationId:string;kind:'worker-http'|'worker-scheduled';outcome:'finished'|'unknown'}):Promise<unknown>;
export function beginSourceWriterDrain(input:SourceWriterInput & {operationId:string;expiresAt:number}):Promise<SourceWriterDrainProof>;
export function observeSourceWriterDrain(input:SourceWriterInput & {operationId:string}):Promise<SourceWriterDrainProof>;
export function releaseSourceWriterDrain(input:SourceWriterInput & {drainId:string;releaseId:string;generation:number}):Promise<unknown>;
export type SourceWriterDrainProof = SourceWriterBinding & {version:1;kind:'dawar-source-writer-drain';scope:'worker-request-and-scheduled-lifetimes';operationId:string;generation:number;expiresAt:number;observedAt:number;status:'expired'|'draining'|'idle';activeWriters:number;unknownWriters:number;retainedFinishedWriters:number;externalWriterCoverageEstablished:false;productionWriterFreezeEstablished:false};
