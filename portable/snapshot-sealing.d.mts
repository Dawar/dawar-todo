export type SnapshotRecipient = { version:1; kind:'dawar-snapshot-recipient'; publicKey:string; privateKey:string; fingerprint:string };
export type SealedSnapshot = { version:1; kind:'dawar-application-snapshot-sealed'; sourceOrigin:string; recipientFingerprint:string; contentSHA256:string; ephemeralPublicKey:string; iv:string; ciphertext:string };
export function newSnapshotRecipient():Promise<SnapshotRecipient>;
export function snapshotRecipient(publicKey:string):Promise<{key:CryptoKey; fingerprint:string}>;
export function sealApplicationSnapshot(snapshot:string,recipient:string,sourceOrigin:string):Promise<SealedSnapshot>;
export function unsealApplicationSnapshot(envelope:SealedSnapshot,recipient:SnapshotRecipient,expectedOrigin:string):Promise<{snapshot:string;sha256:string;sourceOrigin:string;sourceAuthenticationEstablished:false}>;
