import { createHmac, timingSafeEqual } from "node:crypto";

const ACTOR_HEADERS = ["oai-authenticated-user-email","oai-authenticated-user-id","x-dawar-internal-actor-kind","x-dawar-internal-actor-id","x-dawar-internal-actor-name","x-dawar-internal-actor-user-key"];
function content(method:string,path:string,headers:Headers,at:number) {
  return JSON.stringify({ method,path,at,actor:ACTOR_HEADERS.map(h=>headers.get(h)) });
}
export function signGateway(secret:string,method:string,path:string,headers:Headers,at=Date.now()) {
  const proof=createHmac("sha256",secret).update(content(method,path,headers,at)).digest("hex");
  headers.set("x-dawar-gateway-at",String(at));headers.set("x-dawar-gateway-proof",proof);
}
export function verifyGateway(secret:string,method:string,path:string,headers:Headers,now=Date.now()) {
  const at=Number(headers.get("x-dawar-gateway-at")),proof=headers.get("x-dawar-gateway-proof");
  if(!Number.isSafeInteger(at)||Math.abs(now-at)>5000||!proof||!/^[a-f0-9]{64}$/.test(proof))return false;
  return timingSafeEqual(Buffer.from(proof,"hex"),createHmac("sha256",secret).update(content(method,path,headers,at)).digest());
}
