import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join,dirname } from 'node:path';

// Pure preparation. Release owns writing these files. Explicit owner-selected
// policies are preserved; only an unconfigured approved workspace gets a
// default. This does not claim the client's actual effective mode.
export function prepareWorkspaceAccess({workspace,globalConfigPath}) {
  if(!isAbsolute(workspace)||!isAbsolute(globalConfigPath))throw Error('Exact approved workspace and global configuration paths required.');
  const projectPath=join(workspace,'.codex','config.toml');
  const global=existsSync(globalConfigPath)?readFileSync(globalConfigPath,'utf8'):'',project=existsSync(projectPath)?readFileSync(projectPath,'utf8'):'';
  const top=text=>text.split(/^\s*\[/m)[0];
  const configured=text=>/^\s*(sandbox_mode|approval_policy|default_permissions|profile)\s*=/m.test(top(text));
  if(configured(project)||configured(global))return {changed:false,reason:'Explicit owner policy preserved',effective:null};
  for(let parent=dirname(workspace);parent!==dirname(parent);parent=dirname(parent)){
    const path=join(parent,'.codex','config.toml');
    if(path!==globalConfigPath&&existsSync(path)&&configured(readFileSync(path,'utf8')))
      return {changed:false,reason:'Explicit inherited owner policy preserved',effective:null};
  }
  const header=`[projects.${JSON.stringify(workspace)}]`,escaped=header.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const section=new RegExp(`^${escaped}\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`,'m').exec(global);
  if(section&&/^\s*trust_level\s*=\s*"untrusted"/m.test(section[1]))return {changed:false,reason:'Explicit untrusted workspace preserved',effective:null};
  if(section&&!/^\s*trust_level\s*=\s*"trusted"/m.test(section[1]))throw Error('Workspace trust selection is unknown; preserve it.');
  return {changed:true,effective:null,files:[
    {path:projectPath,before:project,after:`# Approved DawarTodo workspace default; a native client may explicitly override it.\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n${project}`},
    ...(!section?[{path:globalConfigPath,before:global,after:`${global.trimEnd()}\n\n${header}\ntrust_level = "trusted"\n`}]:[]),
  ]};
}
