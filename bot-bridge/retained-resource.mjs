// Read-only retirement containment. No room routing, messaging or resource writes.
// Existing unknown/held effects remain protected until explicitly reconciled.
export function assertRetainedResource(store,botId,resource) {
 const rows=store.list('collaborationResource',botId);
 if(rows.some(row=>row.state!=='released'))throw Error(`A retained resource effect requires reconciliation before ${resource} use.`);
}
