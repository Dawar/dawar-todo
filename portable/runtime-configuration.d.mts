import type {SnapshotRecipient,SealedSnapshot} from './snapshot-sealing.mjs';
export type RuntimeConfigurationBinding={sourceOrigin:string;sourceId:string;readId:string;ownerKey:string;ownerUserId:string};
export type SealedRuntimeConfiguration={version:1;kind:'dawar-runtime-configuration-sealed';sourceId:string;readId:string;envelope:SealedSnapshot};
export const RUNTIME_CONFIGURATION_KEYS:readonly string[];
export function sealRuntimeConfiguration(args:{environment:Record<string,unknown>;recipientPublicKey:string;binding:RuntimeConfigurationBinding}):Promise<SealedRuntimeConfiguration>;
export function unsealRuntimeConfiguration(args:{sealed:SealedRuntimeConfiguration;recipient:SnapshotRecipient;expected:RuntimeConfigurationBinding}):Promise<{environment:Record<string,string>;capturedAt:number;contentSHA256:string;sourceAuthenticationEstablished:false}>;
