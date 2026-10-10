// Shared Cloudflare/Node WebCrypto. Public recipient keys are not authorization;
// caller ownership and the original authenticated HTTPS capture stay separate.
const utf8 = new TextEncoder();
const MAXIMUM = 12 * 1024 * 1024;
function encode(bytes) {
  let text='';
  for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
function decode(text,maximum) {
  if(typeof text!=='string'||text.length>Math.ceil(maximum*4/3)+4||!/^[A-Za-z0-9_-]+$/.test(text))throw Error('Invalid sealed-snapshot field.');
  const raw=atob(text.replaceAll('-','+').replaceAll('_','/'));
  if(raw.length>maximum)throw Error('Sealed snapshot exceeds its bounds.');
  const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(encode(bytes)!==text)throw Error('Noncanonical sealed-snapshot field.');
  return bytes;
}
async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function newSnapshotRecipient() {
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey']);
  const publicBytes=new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey));
  return {version:1,kind:'dawar-snapshot-recipient',publicKey:encode(publicBytes),
    privateKey:encode(new Uint8Array(await crypto.subtle.exportKey('pkcs8',pair.privateKey))),fingerprint:await digest(publicBytes)};
}
export async function snapshotRecipient(publicKey) {
  const bytes=decode(publicKey,256);
  return {key:await crypto.subtle.importKey('spki',bytes,{name:'ECDH',namedCurve:'P-256'},false,[]),fingerprint:await digest(bytes)};
}
export async function sealApplicationSnapshot(snapshot,recipient,sourceOrigin) {
  const plaintext=utf8.encode(snapshot);
  if(plaintext.length>MAXIMUM||new URL(sourceOrigin).origin!==sourceOrigin||!sourceOrigin.startsWith('https://'))throw Error('Invalid application snapshot origin or size.');
  const target=await snapshotRecipient(recipient);
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'ECDH',public:target.key},pair.privateKey,{name:'AES-GCM',length:256},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const aad={version:1,kind:'dawar-application-snapshot-sealed',sourceOrigin,recipientFingerprint:target.fingerprint,contentSHA256:await digest(plaintext)};
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8.encode(JSON.stringify(aad))},key,plaintext));
  return {...aad,ephemeralPublicKey:encode(new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey))),iv:encode(iv),ciphertext:encode(ciphertext)};
}
export async function unsealApplicationSnapshot(envelope,recipient,expectedOrigin) {
  if(envelope?.version!==1||envelope.kind!=='dawar-application-snapshot-sealed'||recipient?.version!==1||recipient.kind!=='dawar-snapshot-recipient'||
    envelope.sourceOrigin!==expectedOrigin||!/^https:\/\//.test(expectedOrigin)||new URL(expectedOrigin).origin!==expectedOrigin||!/^[a-f0-9]{64}$/.test(envelope.contentSHA256))throw Error('Sealed snapshot identity differs.');
  const target=await snapshotRecipient(recipient.publicKey);
  if(target.fingerprint!==recipient.fingerprint||envelope.recipientFingerprint!==target.fingerprint)throw Error('Snapshot belongs to a different recipient.');
  const privateKey=await crypto.subtle.importKey('pkcs8',decode(recipient.privateKey,256),{name:'ECDH',namedCurve:'P-256'},false,['deriveKey']);
  const peer=await snapshotRecipient(envelope.ephemeralPublicKey);
  const key=await crypto.subtle.deriveKey({name:'ECDH',public:peer.key},privateKey,{name:'AES-GCM',length:256},false,['decrypt']);
  const aad={version:envelope.version,kind:envelope.kind,sourceOrigin:envelope.sourceOrigin,recipientFingerprint:envelope.recipientFingerprint,contentSHA256:envelope.contentSHA256};
  const iv=decode(envelope.iv,12);
  if(iv.length!==12)throw Error('Invalid snapshot initialization vector.');
  const plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:utf8.encode(JSON.stringify(aad))},key,decode(envelope.ciphertext,MAXIMUM+16)));
  if(plaintext.length>MAXIMUM||await digest(plaintext)!==envelope.contentSHA256)throw Error('Decrypted snapshot changed.');
  return {snapshot:new TextDecoder('utf-8',{fatal:true}).decode(plaintext),sha256:envelope.contentSHA256,
    sourceOrigin:expectedOrigin,sourceAuthenticationEstablished:false};
}

// A page's authenticated identity includes the original capture, request,
// command and complete freeze. Encryption alone is never source authorization.
const PAGE_MAXIMUM=4*1024*1024+16384;
function pageId(value) {
  if(typeof value!=='string'||!value||value.includes('\0')||utf8.encode(value).length>1024)throw Error('Invalid application read identity.');
  return value;
}
export function applicationReadBinding(value) {
  const f=value?.freeze;
  if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['sourceOrigin','captureId','requestId','sequence','commandSHA256','freeze'].includes(k))||
      typeof value.sourceOrigin!=='string'||new URL(value.sourceOrigin).origin!==value.sourceOrigin||!value.sourceOrigin.startsWith('https://')||
      !Number.isSafeInteger(value.sequence)||value.sequence<1||value.sequence>1000000||
      typeof value.commandSHA256!=='string'||!/^[a-f0-9]{64}$/.test(value.commandSHA256)||
      !f||typeof f!=='object'||Object.keys(f).length!==5||Object.keys(f).some(k=>!['sourceId','operationId','epoch','generation','expiresAt'].includes(k))||
      !Number.isSafeInteger(f.epoch)||f.epoch<1||!Number.isSafeInteger(f.generation)||f.generation<1||!Number.isSafeInteger(f.expiresAt))throw Error('Invalid application read binding.');
  return {sourceOrigin:value.sourceOrigin,captureId:pageId(value.captureId),requestId:pageId(value.requestId),sequence:value.sequence,commandSHA256:value.commandSHA256,
    freeze:{sourceId:pageId(f.sourceId),operationId:pageId(f.operationId),epoch:f.epoch,generation:f.generation,expiresAt:f.expiresAt}};
}
export async function sealApplicationRead(payload,recipient,binding) {
  binding=applicationReadBinding(binding);
  const plaintext=utf8.encode(JSON.stringify(payload));if(plaintext.length>PAGE_MAXIMUM)throw Error('Application read page exceeds its bound.');
  const target=await snapshotRecipient(recipient),pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'ECDH',public:target.key},pair.privateKey,{name:'AES-GCM',length:256},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const aad={version:1,kind:'dawar-application-read-sealed',...binding,recipientFingerprint:target.fingerprint,contentSHA256:await digest(plaintext)};
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8.encode(JSON.stringify(aad))},key,plaintext));
  return {...aad,ephemeralPublicKey:encode(new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey))),iv:encode(iv),ciphertext:encode(ciphertext)};
}
export async function unsealApplicationRead(envelope,recipient,expected) {
  expected=applicationReadBinding(expected);
  if(envelope?.version!==1||envelope.kind!=='dawar-application-read-sealed'||Object.keys(envelope).length!==13||
      Object.keys(envelope).some(k=>!['version','kind','sourceOrigin','captureId','requestId','sequence','commandSHA256','freeze','recipientFingerprint','contentSHA256','ephemeralPublicKey','iv','ciphertext'].includes(k))||
      recipient?.version!==1||recipient.kind!=='dawar-snapshot-recipient'||typeof envelope.contentSHA256!=='string'||
      !/^[a-f0-9]{64}$/.test(envelope.contentSHA256))throw Error('Application read envelope differs.');
  const actual=applicationReadBinding(Object.fromEntries(Object.keys(expected).map(k=>[k,envelope[k]])));
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Application read belongs to a different request or freeze.');
  const target=await snapshotRecipient(recipient.publicKey);
  if(target.fingerprint!==recipient.fingerprint||envelope.recipientFingerprint!==target.fingerprint)throw Error('Application read belongs to a different recipient.');
  const privateKey=await crypto.subtle.importKey('pkcs8',decode(recipient.privateKey,256),{name:'ECDH',namedCurve:'P-256'},false,['deriveKey']);
  const peer=await snapshotRecipient(envelope.ephemeralPublicKey),iv=decode(envelope.iv,12);
  if(iv.length!==12)throw Error('Invalid application read initialization vector.');
  const key=await crypto.subtle.deriveKey({name:'ECDH',public:peer.key},privateKey,{name:'AES-GCM',length:256},false,['decrypt']);
  const aad={version:1,kind:'dawar-application-read-sealed',...actual,recipientFingerprint:envelope.recipientFingerprint,contentSHA256:envelope.contentSHA256};
  const plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:utf8.encode(JSON.stringify(aad))},key,decode(envelope.ciphertext,PAGE_MAXIMUM+16)));
  if(plaintext.length>PAGE_MAXIMUM||await digest(plaintext)!==envelope.contentSHA256)throw Error('Decrypted application read changed.');
  return {payload:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)),sourceAuthenticationEstablished:false};
}
