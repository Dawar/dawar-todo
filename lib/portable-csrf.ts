export function portableHeaders(input?:HeadersInit):Headers {
  const headers=new Headers(input);
  // Next replaces this public flag at build time. Source consumers without
  // a process shim keep their existing headers and authentication behavior.
  let enabled=false;try{enabled=process.env.NEXT_PUBLIC_DAWAR_PORTABLE==="1";}catch{}
  if(!enabled||typeof document==="undefined")return headers;
  const value=document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-dawar-csrf='))?.slice('__Host-dawar-csrf='.length);
  if(value&&/^[A-Za-z0-9_-]{43}$/.test(value))headers.set('x-dawar-csrf',value);
  return headers;
}
