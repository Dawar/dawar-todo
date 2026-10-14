(()=>{const input=document.createElement('input');input.type='file';input.accept='.json';document.body.append(input);input.onchange=async()=>{
let c,expiresAt=0,journalGeneration=0,databaseGeneration=0;const receipts=[];
try{
 const file=input.files?.[0];if(!file||file.size>32768)throw Error('Private capture input required');
 const x=JSON.parse(await file.text());c=x.control;const schema=x.reader.freeze.database.schemaSHA256;
 if(location.origin!==c.sourceOrigin||!/^[a-f0-9]{12}$/.test(x.expectedBuild))throw Error('Original owner origin differs');
 const action=async(command)=>{
  const r=await fetch('/api/migration/source/control',{method:'POST',credentials:'include',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json','X-Dawar-Migration-Control':c.credential},body:JSON.stringify(command)});
  const b=await r.json();if(r.status!==200||r.headers.get('X-Dawar-Migration-Deployed-Build')!==x.expectedBuild||b.sourceId!==c.sourceId||b.operationId!==command.operationId||b.action!==command.action)throw Error('Original source control not confirmed');receipts.push(b);return b.result;
 };
 window.__dawarOriginalCopyCleanup=async()=>{
  if(databaseGeneration){const r=await action({action:'database.release',operationId:c.databaseReleaseId,schemaSHA256:schema,generation:databaseGeneration});if(r.releasedOriginal!==true||r.currentPhase!=='open')throw Error('Database release not confirmed');databaseGeneration=0;}
  if(journalGeneration){const r=await action({action:'journal.release',operationId:c.journalReleaseId,schemaSHA256:schema,generation:journalGeneration});if(r.releasedOriginal!==true||r.currentPhase!=='open')throw Error('Journal release not confirmed');journalGeneration=0;}
 };
 const beforeJ=await action({action:'journal.read',operationId:c.journal.installationId});
 const beforeD=await action({action:'database.read',operationId:c.database.installId,schemaSHA256:schema});
 if(!Number.isSafeInteger(x.expectedDatabaseGeneration)||x.expectedDatabaseGeneration<0||x.reader.kind!=='dawar-original-database-reader'||x.reader.recentTailLossAccepted!==true||beforeJ.phase!=='open'||beforeD.phase!=='open'||beforeD.generation!==x.expectedDatabaseGeneration||beforeJ.operationId!==null||beforeD.operationId!==null)throw Error('Original database copy already started; reconcile its receipt');
 expiresAt=Date.now()+900000;
 let frozen;
 try{frozen=await action({action:'database.freeze',operationId:c.cutoverId,schemaSHA256:schema,expiresAt});}
 catch{const r=await action({action:'database.receipt',operationId:c.cutoverId,schemaSHA256:schema,receiptKind:'freeze',expiresAt,generation:0});if(!r.receiptConfirmed||r.outcome!=='frozen')throw Error('Original database outcome remains unknown');databaseGeneration=r.generation;throw Error('Database send lost ACK; release confirmed original without capture retry');}
 databaseGeneration=frozen.generation;
 if(frozen.scope!=='d1-database-writes'||frozen.status!=='frozen'||frozen.guardSHA256!==x.reader.freeze.database.guardSHA256||databaseGeneration!==x.expectedDatabaseGeneration+1)throw Error('Original database binding differs');
 const capture={sourceOrigin:c.sourceOrigin,captureId:x.reader.captureId,freeze:{sourceId:c.sourceId,operationId:c.cutoverId,epoch:frozen.epoch,generation:frozen.generation,expiresAt:frozen.expiresAt,scope:'d1-database-writes'}};
 const m=await import('/migration-database-capture.mjs?build='+x.expectedBuild);
 const result=await m.captureDatabase({capture,recipient:x.recipient,onProgress:p=>console.info('Private database copy progress',p)});
 const out={...result,sourceControlReceipts:receipts};
 const link=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(out)],{type:'application/json'}));link.href=url;link.download='dawar-application-database-capture.sealed.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
 console.info('Original application copy complete',{tables:result.tables.length,bytes:result.bytes,calls:result.calls});
}catch(e){console.error('Original copy retained:',e.message);}
finally{
 if(c&&window.__dawarOriginalCopyCleanup){try{await window.__dawarOriginalCopyCleanup();console.info('Original application copy holds released');delete window.__dawarOriginalCopyCleanup;}catch{console.error('Original copy release not confirmed; retain original IDs and cleanup function');}}
 input.remove();
}
};input.click();})()
