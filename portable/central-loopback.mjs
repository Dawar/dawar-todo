// Installation-only optimization for the co-located Linux agent. Node identity,
// challenge proof, grants and the normal mailbox protocol are unchanged.
// Remote installations always use the public TLS transport.
export function centralLoopback(config) {
  const port=config.agent?.loopbackHubPort;
  if(port===undefined)return null;
  if(process.platform!=='linux'||config.agent?.centralRouting!==true||
      !Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid central loopback transport.');
  return `http://127.0.0.1:${port}`;
}

export function agentConnectionURL(config,hub) {
  const origin=new URL(hub);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
    throw Error('Agent connections require a fixed TLS hub identity.');
  const loopback=centralLoopback(config),url=new URL('/nodes/connect',loopback??origin);
  url.protocol=loopback?'ws:':'wss:';return url;
}
