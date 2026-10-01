/** Modifier-release commits a whole extension, so 2 never wins over 20.
 * Browsers may reserve Ctrl+digits; Alt+digits is the equivalent fallback. */
export function installExtensionShortcuts(target: Pick<Window,'addEventListener'|'removeEventListener'>, select: (extension:number)=>void) {
  let digits='',modifier='';
  const reset=()=>{digits='';modifier='';};
  const down=(event:Event)=>{
    const key=event as KeyboardEvent;
    if(key.key==='Escape'){reset();return;}
    const digit=/^(Digit|Numpad)(\d)$/.exec(key.code)?.[2];
    if(!digit||key.isComposing||key.repeat||key.metaKey||key.ctrlKey&&key.altKey||!(key.ctrlKey||key.altKey))return;
    const next=key.ctrlKey?'Control':'Alt';
    if(modifier&&modifier!==next)reset();
    modifier=next;digits=(digits+digit).slice(0,8);key.preventDefault();
  };
  const up=(event:Event)=>{
    const key=event as KeyboardEvent;
    if(key.key!==modifier)return;
    const extension=Number(digits);reset();
    if(Number.isSafeInteger(extension)&&extension>=2){key.preventDefault();select(extension);}
  };
  target.addEventListener('keydown',down,true);target.addEventListener('keyup',up,true);target.addEventListener('blur',reset);
  return ()=>{target.removeEventListener('keydown',down,true);target.removeEventListener('keyup',up,true);target.removeEventListener('blur',reset);};
}
