const marker=':codex-file-citation{';
/** A display reference grants neither a filesystem read nor an external fetch. */
export function parseFileCitation(raw){
  if(typeof raw!=='string'||raw.length>4096||!raw.startsWith(marker)||!raw.endsWith('}'))return null;
  const body=raw.slice(marker.length,-1),attrs={},field=/\s*(path|purpose)\s*=\s*("(?:[^"\\]|\\.)*")/y;let offset=0;
  while(offset<body.length){
    if(!body.slice(offset).trim())break;
    field.lastIndex=offset;const match=field.exec(body);if(!match||Object.hasOwn(attrs,match[1]))return null;
    try{attrs[match[1]]=JSON.parse(match[2]);}catch{return null;}offset=field.lastIndex;
  }
  const path=attrs.path,purpose=attrs.purpose??'output';
  if(typeof path!=='string'||!path||path.length>2048||/[\x00-\x1f\x7f]/.test(path)||!['input','output'].includes(purpose))return null;
  if(/^[a-z][a-z0-9+.-]*:/i.test(path)){
    try{const u=new URL(path);if(!['https:','http:'].includes(u.protocol)||!u.hostname||u.username||u.password)return null;}catch{return null;}
  }else if(path.startsWith('//')||path.includes('\\')||path.split('/').some(p=>p==='.'||p==='..'))return null;
  return {path,purpose};
}
export function readFileCitation(reference){
  try{const v=JSON.parse(decodeURIComponent(reference));if(!v||Array.isArray(v)||Object.keys(v).some(k=>!['path','purpose'].includes(k)))return null;return parseFileCitation(`${marker}path=${JSON.stringify(v.path)} purpose=${JSON.stringify(v.purpose)}}`);}catch{return null;}
}
function candidate(text,start){
  let quote=false,escape=false;
  for(let i=start+marker.length;i<Math.min(text.length,start+4096);i++){
    const c=text[i];if(escape){escape=false;continue;}if(quote&&c==='\\'){escape=true;continue;}if(c==='"'){quote=!quote;continue;}
    if(c==='}'&&!quote){const value=parseFileCitation(text.slice(start,i+1));return value?{start,end:i+1,...value}:null;}
  }
  return null;
}
/** Selected message only; code examples remain literal and don't hide files. */
export function fileCitationReferences(text){
  if(typeof text!=='string'||!text.includes(marker))return [];
  const refs=[];let fence=null;
  for(let i=0;i<text.length;){
    if(i===0||text[i-1]==='\n'){
      const end=text.indexOf('\n',i),line=text.slice(i,end<0?text.length:end),m=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if(m){if(!fence)fence=m[1];else if(m[1][0]===fence[0]&&m[1].length>=fence.length&&!m[2].trim())fence=null;i=end<0?text.length:end+1;continue;}
      if(fence||/^ {4}\S/.test(line)){i=end<0?text.length:end+1;continue;}
    }
    if(text[i]==='`'){
      let n=1;while(text[i+n]==='`')n++;const run='`'.repeat(n);let close=text.indexOf(run,i+n);
      while(close>=0&&(text[close-1]==='`'||text[close+n]==='`'))close=text.indexOf(run,close+n);
      if(close>=0){i=close+n;continue;}i+=n;continue;
    }
    if(text.startsWith(marker,i)){const ref=candidate(text,i);if(ref){refs.push(ref);i=ref.end;if(refs.length===256)break;continue;}}
    i++;
  }
  return refs;
}
/** Keep bounded long-message paging from slicing through a finished citation. */
export function fileCitationPages(text,size=16384){
  const refs=[...fileCitationReferences(text),...Array.from(text.matchAll(/\[Open file\]\(bot-file-citation:[^)]{1,24576}\)/g),m=>({start:m.index,end:m.index+m[0].length}))],pages=[];
  for(let start=0;start<text.length;){let end=Math.min(text.length,start+size);const crossing=refs.find(r=>r.start<end&&r.end>end);if(crossing)end=crossing.end;pages.push([start,end]);start=end;}
  return pages.length?pages:[[0,0]];
}

export function normalizeFileCitations(text){
  const refs=fileCitationReferences(text);if(!refs.length)return text;
  let offset=0;const parts=[];for(const ref of refs){parts.push(text.slice(offset,ref.start),`[Open file](bot-file-citation:${encodeURIComponent(JSON.stringify({path:ref.path,purpose:ref.purpose}))})`);offset=ref.end;}parts.push(text.slice(offset));return parts.join('');
}
