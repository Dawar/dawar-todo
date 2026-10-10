import { env } from 'cloudflare:workers';
import { taskRequestResponse } from '../../../../lib/task-request-api';
export function POST(request:Request) {return taskRequestResponse(request,env as Cloudflare.Env,'service');}
