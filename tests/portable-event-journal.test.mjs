import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NodeJournal} from '../portable/control-store.mjs';
import {boundedFrame} from '../portable/protocol.mjs';

test('migrated runtime events retain their JSON wire representation and identity',()=>{
  const directory=mkdtempSync(join(tmpdir(),'portable-event-journal-'));
  const journal=new NodeJournal(join(directory,'journal.sqlite'));
  try {
    const event={botId:'bot-one',epoch:1,event:{seq:9,type:'run.state',data:{run:{id:'run-one',result:undefined,config:{model:undefined}},background:{running:0}}}};
    const wire=JSON.parse(JSON.stringify(event));
    const sequence=journal.recordEvent('event-one',event);
    assert.deepEqual(JSON.parse(journal.pendingEvents()[0].event),wire);
    assert.equal(journal.recordEvent('event-one',wire),sequence);
    assert.throws(()=>journal.recordEvent('event-one',{...wire,epoch:2}),/identity differs/);
    assert.throws(()=>boundedFrame({operationId:'command-one',result:undefined}),/Noncanonical/);
  }finally{journal.close();rmSync(directory,{recursive:true,force:true});}
});
