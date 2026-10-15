import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerConflict } from '../portable/deploy-plan.mjs';

test('the controller unit running this very process is not a conflicting run', () => {
  const active = { ActiveState: 'active', InvocationID: 'a26bd04b0ca24a81ba27603c44667581' };
  // `launch` starts `run` inside the plan's controller unit: preflight there sees itself.
  assert.equal(controllerConflict(active, 'a26bd04b0ca24a81ba27603c44667581'), false);
  // Another invocation, or a shell outside any unit, is a second run of the plan.
  assert.equal(controllerConflict(active, 'ffffffffffffffffffffffffffffffff'), true);
  assert.equal(controllerConflict(active, undefined), true);
  assert.equal(controllerConflict({ ActiveState: 'activating', InvocationID: 'x' }, 'y'), true);
  assert.equal(controllerConflict({ ActiveState: 'inactive', InvocationID: '' }, undefined), false);
  assert.equal(controllerConflict(null), false);
});
