// These defaults apply to the owner's ordinary bot execution. Private review
// capabilities must use their own explicitly read-only execution policy.
export const EXECUTION_ACCESS = Object.freeze({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
export const turnExecutionAccess = () => ({ approvalPolicy: EXECUTION_ACCESS.approvalPolicy, sandboxPolicy: { type: 'dangerFullAccess' } });
export const executionAccessStatus = () => ({ configured: { ...EXECUTION_ACCESS, networkAccess: 'enabled' }, effective: null });
