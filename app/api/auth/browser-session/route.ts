import {env} from 'cloudflare:workers';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  const binding=(env as unknown as {DAWAR_BROWSER_SESSION?:{read(request:Request):Response}}).DAWAR_BROWSER_SESSION;
  return binding?binding.read(request):Response.json({error:'Browser session unavailable.'},{status:404,headers:{'Cache-Control':'no-store'}});
}
