import { NextRequest, NextResponse } from "next/server";
import { loadConfig } from "./portable/config.mjs";
import { verifyGateway } from "./portable/gateway-proof";

export function proxy(request:NextRequest) {
  if(process.env.NEXT_PUBLIC_DAWAR_PORTABLE!=="1")return NextResponse.next();
  const c=loadConfig();
  // Loopback is a transport boundary, not identity authority. A direct local
  // request cannot impersonate the owner by adding the old hosting headers.
  if(!verifyGateway(c.gatewaySecret,request.method,request.nextUrl.pathname+request.nextUrl.search,request.headers))
    return NextResponse.json({error:"Authenticated gateway required."},{status:403});
  const headers=new Headers(request.headers);
  headers.delete("x-dawar-gateway-at");headers.delete("x-dawar-gateway-proof");
  return NextResponse.next({request:{headers}});
}
export const config={matcher:"/:path*"};
