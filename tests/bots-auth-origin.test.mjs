import test from 'node:test';
import assert from 'node:assert/strict';
import { botsOwner } from '../lib/bots-auth.ts';

const owner = { BOTS_OWNER_EMAIL:'owner@example.test', BOTS_OWNER_USER_ID:'owner-id' };
const portable = { ...owner, BOTS_PUBLIC_ORIGIN:'https://todo.example.test' };
const request = (url, origin, extra={}) => new Request(url, { method:'POST', headers:{
  Origin:origin, 'oai-authenticated-user-id':'owner-id', ...extra,
} });

test('portable bot sessions accept the configured HTTPS origin over loopback', () => {
  assert.equal(botsOwner(request('http://127.0.0.1:3211/api/bots/session','https://todo.example.test'),portable),owner.BOTS_OWNER_EMAIL);
});
test('portable bot sessions reject foreign origins and forwarded-host spoofing', () => {
  for (const origin of ['https://foreign.example.test','http://127.0.0.1:3211','http://todo.example.test']) {
    assert.throws(() => botsOwner(request('http://127.0.0.1:3211/api/bots/session',origin,{
      'x-forwarded-host':new URL(origin).host, 'x-forwarded-proto':new URL(origin).protocol.slice(0,-1),
    }),portable),/Invalid request origin/);
  }
});
test('portable origin does not replace owner identity or session requirements', () => {
  assert.throws(() => botsOwner(request('http://127.0.0.1:3211/api/bots/session','https://todo.example.test',{
    'oai-authenticated-user-id':'other-owner',
  }),portable),/only to the owner/);
  assert.throws(() => botsOwner(request('http://127.0.0.1:3211/api/bots/session','https://todo.example.test',{
    Authorization:'Bearer unrelated',
  }),portable),/signed-in session/);
});
test('hosted deployments retain their request URL origin check', () => {
  assert.equal(botsOwner(request('https://todo.example.test/api/bots/session','https://todo.example.test'),owner),owner.BOTS_OWNER_EMAIL);
  assert.throws(() => botsOwner(request('https://todo.example.test/api/bots/session','https://foreign.example.test'),owner),/Invalid request origin/);
});
test('invalid configured origins fail closed', () => {
  for(const value of ['http://todo.example.test','https://todo.example.test/path','https://user@todo.example.test','https://todo.example.test/?x=1','https://todo.example.test/#fragment',''])
    assert.throws(() => botsOwner(request('http://127.0.0.1:3211/api/bots/session','https://todo.example.test'),{...portable,BOTS_PUBLIC_ORIGIN:value}));
});
