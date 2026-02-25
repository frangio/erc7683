import type { SolverContext } from './context.ts';
import type { ResolvedOrder } from './types.ts';
import { quote } from './quote.ts';
import { fill } from './fill.ts';

// Assumes the order is well-formed:
// - Steps with RevertPolicy(drop):
//    - Must not have payments
//    - Must not have TxOutputs

export async function process(ctx: SolverContext, order: ResolvedOrder): Promise<void> {
  preflight(ctx, order);

  const { env, flows: _ } = await quote(ctx, order);

  // TODO: prefill - check inventory, limits, erc20 allowance

  const filled = await fill(ctx, order, env);
  if (!filled) return;
}


function preflight(ctx: SolverContext, order: ResolvedOrder): void {
  if (!hasValidRevertPolicies(order)) {
    throw new Error('Invalid RevertPolicy order');
  }

  const earliestDeadline = getEarliestDeadline(order);
  // TODO: this condition is too coarse, we should check worst case delay for each step against its deadline
  const MAX_FILL_TIME_SECONDS = 10 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (now + MAX_FILL_TIME_SECONDS >= earliestDeadline) {
    throw new Error('Deadline too close or already expired');
  }

  // TODO: check filler exclusivity

  for (const assumption of order.assumptions) {
    if (!ctx.isWhitelisted(assumption.trusted, assumption.kind)) {
      throw new Error(`Untrusted account ${assumption.trusted.address} kind '${assumption.kind}'`);
    }
  }

  for (const variable of order.variables) {
    if (variable.type === 'Witness' && !ctx.getWitnessResolver(variable.kind)) {
      throw new Error(`Unsupported witness kind '${variable.kind}'`);
    }
  }
}

function hasValidRevertPolicies(order: ResolvedOrder): boolean {
  const firstFillIdx = order.steps.findIndex(step =>
    step.attributes.SpendsERC20.length > 0
  );

  const lastDropIdx = order.steps.findLastIndex(step =>
    step.attributes.RevertPolicy.some(policy => policy.policy === 'drop'),
  );

  // TODO: upper bound on gas spend before drop?

  return lastDropIdx <= firstFillIdx;
}

function getEarliestDeadline(order: ResolvedOrder): number {
  let earliest = Infinity;
  for (const step of order.steps) {
    const deadline = step.attributes.RequiredBefore?.deadline;
    if (deadline !== undefined && deadline < earliest) {
      earliest = Number(deadline);
    }
  }
  return earliest;
}
