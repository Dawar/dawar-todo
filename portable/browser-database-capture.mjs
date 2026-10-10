import {createApplicationReadClient} from './application-read-transport.mjs';
import {cellSQL} from './application-read-source.mjs';
import {sealApplicationSnapshot} from './snapshot-sealing.mjs';
const encode=v=>new TextEncoder().encode(v),line=v=>JSON.stringify(v)+'\n';
const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encode(v))),b=>b.toString(16).padStart(2,'0')).join('');
const fail=()=>Error('The original database capture is incomplete. Keep production and original receipts unchanged.');

// Runs only when deliberately opened by the authenticated migration owner.
// Private recipient/config input is chosen locally, never embedded in an asset.
// Source commands are the existing typed, encrypted, owner-only read contract.
export async function captureDatabase({capture,recipient,onProgress=()=>{}}){
  if(capture?.freeze?.scope!=='d1-database-writes'||location.origin!==capture.sourceOrigin)throw fail();
  const client=createApplicationReadClient({capture,recipient,fetchOwned:(url,init)=>fetch(url,init)});
  let calls=0;const read=async command=>{calls++;return client.read(command);};
  try{
    const schema=await read({kind:'schema'}),list=await read({kind:'tables'}),tables=[];
    for(const item of schema.filter(s=>s.type==='table')){
      const table=list.find(t=>t.schema==='main'&&t.name===item.name);
      if(!table||table.type!=='table')throw fail();
      const x=await read({kind:'columns',table:item.name}),columns=x.filter(c=>c.hidden===0).map(c=>c.name);
      let order;
      if(table.wr)order=x.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      else{const k=['_rowid_','rowid','oid'].find(n=>!x.some(c=>c.name.toLowerCase()===n));if(!k)throw fail();columns.unshift(k);order=[k];}
      const count=await read({kind:'count',table:item.name}),rows=count[0]?.n;
      if(!Number.isSafeInteger(rows)||rows<0||rows>10000000||!columns.length||!order.length)throw fail();
      tables.push({name:item.name,columns,order,rows});
    }
    if(tables.length>1000||tables.reduce((n,t)=>n+t.rows,0)>10000000)throw fail();
    const sequence=(await read({kind:'sequence-present'})).length?await read({kind:'sequences'}):[];
    const header={kind:'header',format:'dawar-application-snapshot',version:2,schema,tables,sequence,userVersion:null,applicationId:null,sourceMetadata:{engine:'cloudflare-d1',sqliteHeader:'unavailable'}};
    const content=[line(header)],inventory=[];let total=encode(content[0]).length;
    for(const t of tables){
      const records=[];let last=null,rows=0;
      for(;;){
        const sizes=await read({kind:'sizes',table:t.name,last,limit:256});let limit=0,weight=0;
        for(const s of sizes){
          if(!Number.isSafeInteger(s.bytes)||s.bytes>4*1024*1024||s.bytes<0)throw fail();
          t.order.forEach((_,i)=>cellSQL(s['k'+i]));
          if(limit&&weight+s.bytes>1024*1024)break;weight+=s.bytes;limit++;
        }
        if(!limit)break;
        const data=await read({kind:'rows',table:t.name,last,limit});if(data.length!==limit)throw fail();
        for(const r of data){
          const cells=t.columns.map((_,i)=>r['c'+i]);cells.forEach(cellSQL);if(++rows>t.rows)throw fail();
          const text=line({kind:'row',table:t.name,cells});total+=encode(text).length;
          if(total>256*1024*1024)throw fail();records.push(text);last=t.order.map(k=>cells[t.columns.indexOf(k)]);
        }
        onProgress({tables:inventory.length,rows,calls});
      }
      if(rows!==t.rows||(await read({kind:'count',table:t.name}))[0]?.n!==t.rows)throw fail();
      const text=records.join('');inventory.push({name:t.name,rows,sha256:await hash(text)});content.push(text);
    }
    if(JSON.stringify(await read({kind:'schema'}))!==JSON.stringify(schema))throw fail();
    const proof=await client.verifyFreeze(),text=content.join(''),footer=line({kind:'footer',tables:inventory,sha256:await hash(text)}),complete=text+footer;
    // Seal bounded chunks, not a plaintext database download. Chunk order and
    // whole SHA are verified again before the inactive local SQLite import.
    const chunks=[];let part=[],partBytes=0;
    for(const section of [...content,footer]){
      for(const record of section.split(/(?<=\n)/)){
        const size=encode(record).length;if(size>4*1024*1024)throw fail();
        if(partBytes&&partBytes+size>8*1024*1024){chunks.push(await sealApplicationSnapshot(part.join(''),recipient.publicKey,capture.sourceOrigin));part=[];partBytes=0;}
        part.push(record);partBytes+=size;
      }
    }
    if(partBytes)chunks.push(await sealApplicationSnapshot(part.join(''),recipient.publicKey,capture.sourceOrigin));
    await client.verifyFreeze();
    return {version:1,kind:'dawar-database-capture-chunks',capture,proof,bytes:encode(complete).length,sha256:await hash(complete),chunks,tables:inventory,calls,recentTailLossAccepted:true,fullExternalWriterFreezeEstablished:false};
  }finally{client.close();}
}

export function openDatabaseCapture(){
  const input=document.createElement('input');input.type='file';input.accept='.json';
  input.addEventListener('change',async()=>{
    try{
      const file=input.files?.[0];if(!file||file.size>32768)throw fail();
      const {capture,recipient}=JSON.parse(await file.text());
      const result=await captureDatabase({capture,recipient,onProgress:p=>console.info('Private database capture progress',p)});
      const link=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(result)],{type:'application/json'}));
      link.href=url;link.download='dawar-application-database-capture.sealed.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
      console.info('Private database capture finished',{tables:result.tables.length,bytes:result.bytes,calls:result.calls});
    }catch{console.error('Private database capture failed; original receipts and production retained.');}
    finally{input.remove();}
  },{once:true});input.click();
}
