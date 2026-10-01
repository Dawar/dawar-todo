/** Modifier-release commits a whole extension, so 2 never wins over 20.
 * Browsers may reserve Ctrl+digits; Alt+digits is the equivalent fallback. */
export function installExtensionShortcuts(target: Pick<Window,'addEventListener'|'removeEventListener'>, select: (extension:number,move:boolean)=>void) {
  let digits='',modifier='',move=false;
  const reset=()=>{digits='';modifier='';move=false;};
  const down=(event:Event)=>{
    const key=event as KeyboardEvent;
    if(key.key==='Escape'){reset();return;}
    const digit=/^(Digit|Numpad)(\d)$/.exec(key.code)?.[2];
    if(!digit||key.isComposing||key.repeat||key.metaKey||key.ctrlKey&&key.altKey||!(key.ctrlKey||key.altKey))return;
    const next=key.ctrlKey?'Control':'Alt';
    if(modifier&&modifier!==next)reset();
    modifier=next;move ||= key.shiftKey;digits=(digits+digit).slice(0,8);key.preventDefault();
  };
  const up=(event:Event)=>{
    const key=event as KeyboardEvent;
    if(key.key!==modifier)return;
    const extension=Number(digits),transfer=move;reset();
    if(Number.isSafeInteger(extension)&&extension>=2){key.preventDefault();select(extension,transfer);}
  };
  target.addEventListener('keydown',down,true);target.addEventListener('keyup',up,true);target.addEventListener('blur',reset);
  return ()=>{target.removeEventListener('keydown',down,true);target.removeEventListener('keyup',up,true);target.removeEventListener('blur',reset);};
}
