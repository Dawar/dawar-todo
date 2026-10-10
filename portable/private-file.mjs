import { openSync,readFileSync,fstatSync,closeSync,constants,mkdirSync,writeFileSync,fsyncSync,renameSync,unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readPrivate(path,maximum=128*1024) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const s=fstatSync(fd);
    if (!s.isFile() || s.mode&0o077 || process.getuid && s.uid!==process.getuid() || s.size>maximum) throw Error('Private file has invalid ownership, permissions or size.');
    return readFileSync(fd,'utf8');
  } finally { closeSync(fd); }
}
export function savePrivate(path,text,{exclusive=false}={}) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temporary=exclusive?path:`${path}.${randomUUID()}.tmp`;
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,text);fsyncSync(fd); } catch (e) { try{unlinkSync(temporary);}catch{}throw e; } finally { closeSync(fd); }
  if(!exclusive)renameSync(temporary,path);
  const directory=openSync(dirname(path),constants.O_RDONLY);
  try{fsyncSync(directory);}finally{closeSync(directory);}
}
