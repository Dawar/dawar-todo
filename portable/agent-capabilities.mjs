// This is private installation configuration, never a browser or bot command.
// The installed agent separately verifies its exact release/activation before
// opening a native process. Unselected transports stay unavailable by default.
export function centralAgentCapabilities(config,platform=process.platform) {
  const selected=config.agent?.centralRouting;
  if(selected!==undefined&&typeof selected!=='boolean')throw Error('Invalid central routing configuration.');
  const enabled=platform==='linux'&&selected===true;
  return {centralRoomDispatch:enabled,centralPrimaryDispatch:enabled,centralPeers:enabled,centralTaskRequests:enabled,centralOperator:enabled};
}
