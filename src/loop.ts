import type { SolverContext } from './context.ts';
import type { ResolvedOrder } from './types.ts';
import { quote } from './quote.ts';

export async function process(ctx: SolverContext, order: ResolvedOrder): Promise<void> {
  preflight(ctx, order);

  const { env } = await quote(ctx, order);

  // TODO: check inventory & limits

  // TODO: fill
  // - execute steps in dependency order
  // - resolve remaining variables as needed via env.get(...)
  // - resolve Witnesses mid-execution via ctx.getWitnessResolver
  // - extract TxOutput variables from receipts
}

function preflight(ctx: SolverContext, order: ResolvedOrder): void {
  // TODO: check deadlines, filler exclusivity

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
