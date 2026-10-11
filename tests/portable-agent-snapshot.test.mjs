import test from 'node:test';
import assert from 'node:assert/strict';
import {agentSnapshot} from '../portable/agent-snapshot.mjs';

test('a large migrated history does not exceed the per-bot snapshot transport', () => {
  const snapshot={ready:true,cursor:100,capabilities:{nativeConversation:1},
    bots:[{id:'first',name:'First'},{id:'second',name:'Second'}],
    schedules:Array.from({length:60},(_,i)=>({id:`s${i}`,botId:'second',prompt:'s'.repeat(4000)})),
    runs:Array.from({length:100},(_,i)=>({id:`r${i}`,botId:'second',output:'r'.repeat(9000)})),
    workByBot:[{botId:'first',status:'idle'},{botId:'second',status:'running'}],
    pending:[{botId:'first',key:'retained-question'},{botId:'second',key:'other-question'}],
    secureInputs:[{botId:'second',id:'private-other-bot'}],
    activeScheduledTurns:[{botId:'second',turnId:'active-turn'}]};
  const original=JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(original)>900*1024);
  const result=agentSnapshot(snapshot,'first');
  assert.ok(Buffer.byteLength(JSON.stringify({type:'rpc-result',result}))<900*1024);
  assert.deepEqual(result.bots,[{id:'first',name:'First'}]);
  assert.deepEqual(result.pending,[{botId:'first',key:'retained-question'}]);
  assert.deepEqual(result.secureInputs,[]);
  assert.deepEqual(result.activeScheduledTurns,[]);
  assert.deepEqual(result.schedules,[]);
  assert.deepEqual(result.runs,[]);
  assert.equal(result.ready,true);
  assert.equal(JSON.stringify(snapshot),original);
});
