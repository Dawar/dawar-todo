// Runtime selection is supplied by trusted host configuration, never a request
// field/header. Cloudflare keeps its original transport and background behavior.
export type VoiceRuntimeAdapter = {
  fetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>;
  socket(url:string|URL,protocols?:string[]):WebSocket;
  pair():{0:WebSocket;1:WebSocket};
  upgrade(socket:WebSocket):Response;
  background(context:ExecutionContext|DurableObjectState,factory:()=>Promise<unknown>):void;
};
export type VoicePlatformEnvironment={VOICE_RUNTIME?:VoiceRuntimeAdapter};
export function voiceFetch(env:VoicePlatformEnvironment,input:RequestInfo|URL,init?:RequestInit) {
  return env.VOICE_RUNTIME?env.VOICE_RUNTIME.fetch(input,init):fetch(input,init);
}
export function voiceSocket(env:VoicePlatformEnvironment,url:string|URL,protocols?:string[]) {
  return env.VOICE_RUNTIME?env.VOICE_RUNTIME.socket(url,protocols):new WebSocket(url,protocols);
}
export function voicePair(env:VoicePlatformEnvironment) {
  return env.VOICE_RUNTIME?env.VOICE_RUNTIME.pair():new WebSocketPair();
}
export function voiceUpgrade(env:VoicePlatformEnvironment,socket:WebSocket) {
  return env.VOICE_RUNTIME?env.VOICE_RUNTIME.upgrade(socket):new Response(null,{status:101,webSocket:socket} as ResponseInit);
}
export function voiceWaitUntil(env:VoicePlatformEnvironment,context:ExecutionContext|DurableObjectState,factory:()=>Promise<unknown>) {
  if(env.VOICE_RUNTIME)env.VOICE_RUNTIME.background(context,factory);
  else context.waitUntil(factory());
}
