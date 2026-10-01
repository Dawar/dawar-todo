import test from 'node:test';import assert from 'node:assert/strict';import {runtime} from './helpers/load-ts.mjs';
test('extension shortcuts commit a whole number on release, including Shift, and blur cancels browser-owned shortcuts',()=>{
 const {installExtensionShortcuts}=runtime().load('app/bots/extension-shortcuts.ts'),target=new EventTarget(),picked=[];
 const cleanup=installExtensionShortcuts(target,n=>picked.push(n));
 const key=(type,props)=>{const event=Object.assign(new Event(type,{cancelable:true}),props);target.dispatchEvent(event);return event;};
 key('keydown',{code:'Digit2',key:'2',ctrlKey:true});assert.deepEqual(picked,[]);key('keydown',{code:'Digit0',key:'0',ctrlKey:true,shiftKey:true});key('keyup',{key:'Control'});assert.deepEqual(picked,[20]);
 key('keydown',{code:'Digit3',key:'#',altKey:true,shiftKey:true});key('keyup',{key:'Alt'});assert.deepEqual(picked,[20,3]);
 key('keydown',{code:'Digit2',key:'2',ctrlKey:true});target.dispatchEvent(new Event('blur'));key('keyup',{key:'Control'});assert.deepEqual(picked,[20,3]);cleanup();
});
