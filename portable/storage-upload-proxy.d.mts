export function createStorageUploadProxy(input:{sourceId:string;publicOrigin:string;providerOrigin:string;secret:string;transport?:typeof fetch}):{
  target(provider:{url:string;fields:Record<string,string>},bounds:{minimumBytes:number;maximumBytes:number}):Promise<{url:string;fields:Record<string,string>}>;
  handle(request:Request):Promise<Response>;
};
