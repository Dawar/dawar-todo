// These defaults apply to the owner's ordinary bot execution. Private review
// capabilities must use their own explicitly read-only execution policy.
export const EXECUTION_ACCESS = Object.freeze({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
export const turnExecutionAccess = () => ({ approvalPolicy: EXECUTION_ACCESS.approvalPolicy, sandboxPolicy: { type: 'dangerFullAccess' } });
export const executionAccessStatus = () => ({ configured: { ...EXECUTION_ACCESS, networkAccess: 'enabled' }, effective: null });
export const PRIVATE_REVIEW = Symbol('application-private-read-only-review');

// A resumed thread may carry settings saved by a different client. Bind the
// owner's full-access policy at every ordinary native execution boundary.
// Read APIs and steering preserve their native schemas and current turn.
export function managedExecutionParams(method, params) {
  if(['thread/fork','turn/start'].includes(method)&&params[PRIVATE_REVIEW]===true){
    const review={...params};delete review[PRIVATE_REVIEW];
    if(method==='turn/start')return {...review,approvalPolicy:'never',sandboxPolicy:{type:'readOnly'}};
    return {...review,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',
      config:{...review.config,approval_policy:'never',sandbox_mode:'read-only','features.multi_agent':false}};
  }
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(method))
    return { ...params, ...EXECUTION_ACCESS,
      config: { ...params.config, approval_policy: 'never', sandbox_mode: 'danger-full-access' } };
  if (method === 'turn/start') return { ...params, ...turnExecutionAccess() };
  return params;
}
