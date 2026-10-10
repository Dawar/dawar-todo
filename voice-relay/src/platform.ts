// Runtime selection is supplied by trusted host configuration, never a request
// field/header. Cloudflare keeps its original transport and background behavior.
export type VoiceRuntimeAdapter = {
  fetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>;
  socket(url:string|URL,protocols?:string[]):WebSocket;
  pair():{0:WebSocket;1:WebSocket};
  upgrade(socket:WebSocket):Response;
  background(context:ExecutionContext|DurableObjectState,factory:()=>Promise<unknown>):void;
};
import type {VoiceMigrationEnvironment} from './migration';
export type VoicePlatformEnvironment=VoiceMigrationEnvironment & {VOICE_RUNTIME?:VoiceRuntimeAdapter};
export function voiceFetch(env:VoicePlatformEnvironment,input:RequestInfo|URL,init?:RequestInit) {
  const work=()=>env.VOICE_RUNTIME?env.VOICE_RUNTIME.fetch(input,init):fetch(input,init);
  return env.VOICE_EFFECT_SCOPE?env.VOICE_EFFECT_SCOPE.track(async()=>env.VOICE_EFFECT_SCOPE!.response(await work())):work();
}
export function voiceSocket(env:VoicePlatformEnvironment,url:string|URL,protocols?:string[]) {
  env.VOICE_EFFECT_SCOPE?.assertOpen();
  const socket=env.VOICE_RUNTIME?env.VOICE_RUNTIME.socket(url,protocols):new WebSocket(url,protocols);
  return env.VOICE_EFFECT_SCOPE?env.VOICE_EFFECT_SCOPE.socket(socket):socket;
}
export function voicePair(env:VoicePlatformEnvironment) {
  env.VOICE_EFFECT_SCOPE?.assertOpen();
  const pair=env.VOICE_RUNTIME?env.VOICE_RUNTIME.pair():new WebSocketPair();env.VOICE_EFFECT_SCOPE?.socket(pair[1]);return pair;
}
export function voiceUpgrade(env:VoicePlatformEnvironment,socket:WebSocket) {
  return env.VOICE_RUNTIME?env.VOICE_RUNTIME.upgrade(socket):new Response(null,{status:101,webSocket:socket} as ResponseInit);
}
export function voiceWaitUntil(env:VoicePlatformEnvironment,context:ExecutionContext|DurableObjectState,factory:()=>Promise<unknown>) {
  if(env.VOICE_RUNTIME)env.VOICE_RUNTIME.background(context,factory);
  else context.waitUntil(env.VOICE_EFFECT_SCOPE?env.VOICE_EFFECT_SCOPE.track(factory):factory());
}
