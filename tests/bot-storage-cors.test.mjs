import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypeScript} from './fixtures/bot-storage-runtime.mjs';
const {botStorageResponse}=loadTypeScript('lib/bot-storage-api.ts');
const env={S3_ACCESS_KEY:'synthetic-secret',S3_ACCESS_KEY_ID:'synthetic-id',S3_BUCKET:'private-test',S3_ENDPOINT_URL:'nyc3.digitaloceanspaces.com',BOTS_OWNER_EMAIL:'owner@example.test',BOTS_OWNER_USER_ID:'owner-id',BOTS_MACHINE_ID:'machine',BOTS_STORAGE_SERVICE_SECRET:'storage-only'};
const request=(headers={Authorization:'Bearer storage-only','X-Bots-Machine':'machine'})=>new Request('https://work.example.test/api/bots/storage/service',{method:'POST',headers,body:JSON.stringify({action:'providerCors'})});
function provider(t,response){const prior=globalThis.fetch;const calls=[];globalThis.fetch=async input=>{calls.push(input);return response.clone()};t.after(()=>{globalThis.fetch=prior});return calls;}
test('provider configuration stays private, service and machine bound, with no D1/object access',async t=>{
 const calls=provider(t,new Response('unused'));
 assert.equal((await botStorageResponse(request({} ),env,true)).status,401);
 assert.equal((await botStorageResponse(request({Authorization:'Bearer storage-only','X-Bots-Machine':'wrong'}),env,true)).status,401);
 assert.equal((await botStorageResponse(request({'oai-authenticated-user-id':'owner-id'}),env)).status,403);
 assert.equal(calls.length,0);
});
test('read-only signed existing-key probe reports actual provider denial without secrets',async t=>{
 const calls=provider(t,new Response('<Error><Code>AccessDenied</Code><Message>private provider detail</Message></Error>',{status:403}));
 const result=await botStorageResponse(request(),env,true);assert.equal(result.status,200);
 assert.deepEqual(await result.json(),{providerCors:{http:403,code:'AccessDenied',configured:null,rules:[]}});
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(new URL(calls[0].url).pathname,'/private-test/');assert.ok(new URL(calls[0].url).searchParams.has('cors'));assert.match(calls[0].headers.get('authorization'),/^AWS4-HMAC-SHA256 /);
});
test('read-only CORS diagnostics preserve all existing rule origins and methods',async t=>{
 provider(t,new Response('<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule><AllowedOrigin>https://work.example.test</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds></CORSRule><CORSRule><AllowedOrigin>https://existing.example.test</AllowedOrigin><AllowedMethod>HEAD</AllowedMethod></CORSRule></CORSConfiguration>'));
 const result=await (await botStorageResponse(request(),env,true)).json();assert.equal(result.providerCors.rules.length,2);assert.deepEqual(result.providerCors.rules[0].allowedMethods,['GET','POST']);assert.equal(result.providerCors.rules[1].allowedOrigins[0],'https://existing.example.test');assert.equal(result.providerCors.rules[0].maxAgeSeconds,300);
});
test('missing provider CORS is distinguished from denied access and malformed/oversized output stays private',async t=>{
 const prior=globalThis.fetch;t.after(()=>{globalThis.fetch=prior});globalThis.fetch=async()=>new Response('<Error><Code>NoSuchCORSConfiguration</Code></Error>',{status:404});
 assert.equal((await (await botStorageResponse(request(),env,true)).json()).providerCors.configured,false);
 globalThis.fetch=async()=>new Response('private '.repeat(10000));const response=await botStorageResponse(request(),env,true);assert.equal(response.status,502);assert.equal((await response.json()).code,'unavailable');
});
