import type { Address } from 'viem';
import { decodeAbiParameters } from 'viem';
import type { Formula, ResolvedOrder, Step } from './types.ts';
import type { SolverContext } from './context.ts';
import { VariableEnv, envSimulateCall } from './env.ts';

interface QuoteResult {
  env: VariableEnv; // resolved variables, passed to fill
}

export async function quote(
  ctx: SolverContext,
  order: ResolvedOrder,
): Promise<QuoteResult> {
  const flowFormulas = collectFlowFormulas(order);

  const pricingVars = collectPricingVars(order);
  if (pricingVars.length > 0) {
    // TODO: use black box optimization to find values based on computed pnl
    throw new Error('Pricing variables not supported');
  }

  const env = new VariableEnv(ctx, order.variables);
  const flowAmounts = await computeFlowAmounts(ctx, env, flowFormulas);
  const pnlUsd = computePnLUsd(ctx, flowAmounts);

  if (pnlUsd < 0n) {
    throw new Error('Negative PnL');
  }

  return { env };
}

function collectPricingVars(order: ResolvedOrder): number[] {
  const pricingVars: number[] = [];
  for (let i = 0; i < order.variables.length; i++) {
    if (order.variables[i]?.type === 'Pricing') {
      pricingVars.push(i);
    }
  }
  return pricingVars;
}

function computePnLUsd(
  ctx: SolverContext,
  flows: Required<AssetFlow<bigint>>[],
): bigint {
  let pnl = 0n;

  for (const flow of flows) {
    const price = flow.token === 'gas'
      ? ctx.getGasPriceUsd(flow.chainId)
      : ctx.getTokenPriceUsd({ address: flow.token, chainId: flow.chainId });

    pnl += flow.amount * flow.sign * price;
  }

  return pnl;
}

type AssetFlow<TAmount> = TokenFlow<TAmount> | GasFlow<TAmount>;

interface TokenFlow<TAmount> {
  chainId: bigint;
  token: Address;
  amount: TAmount;
  sign: 1n | -1n;
}

interface GasFlow<TAmount> {
  chainId: bigint;
  token: 'gas';
  amount?: TAmount;
  sign: -1n;
  step: Step;
}

function collectFlowFormulas(order: ResolvedOrder): AssetFlow<Formula>[] {
  const flows: AssetFlow<Formula>[] = [];

  for (const step of order.steps) {
    const gasFlow: GasFlow<Formula> = {
      chainId: step.target.chainId,
      token: 'gas',
      step,
      sign: -1n,
    };

    flows.push(gasFlow);

    for (const attribute of step.attributes) {
      switch (attribute.type) {
        case 'SpendsERC20': {
          flows.push({
            chainId: attribute.token.chainId,
            token: attribute.token.address,
            amount: attribute.amountFormula,
            sign: -1n,
          });
          break;
        }

        case 'SpendsEstimatedGas': {
          gasFlow.amount = attribute.amountFormula;
          break;
        }
      }
    }

    for (const payment of step.payments) {
      if (payment.type === 'ERC20') {
        flows.push({
          chainId: payment.token.chainId,
          token: payment.token.address,
          amount: payment.amountFormula,
          sign: 1n,
        });
      }
    }
  }

  for (const payment of order.payments) {
    if (payment.type === 'ERC20') {
      flows.push({
        chainId: payment.token.chainId,
        token: payment.token.address,
        amount: payment.amountFormula,
        sign: 1n,
      });
    }
  }

  return flows;
}

async function computeFlowAmounts(
  ctx: SolverContext,
  env: VariableEnv,
  flows: AssetFlow<Formula>[],
): Promise<Required<AssetFlow<bigint>>[]> {
  const evaluated: Required<AssetFlow<bigint>>[] = [];

  for (const flow of flows) {
    if (flow.token === 'gas') {
      let amount = flow.amount && await evalFormula(env, flow.amount);

      if (amount === undefined) {
        const { gasUsed, status } = await envSimulateCall(ctx, env, flow.step);
        if (status !== 'success') {
          throw new Error('Gas simulation failed');
        }
        amount = gasUsed;
      }
      evaluated.push({ ...flow, amount: amount });
    } else {
      const amount = await evalFormula(env, flow.amount);
      evaluated.push({ ...flow, amount: amount });
    }
  }

  return evaluated;
}

async function evalFormula(env: VariableEnv, formula: Formula): Promise<bigint> {
  switch (formula.type) {
    case 'Const': {
      return formula.val;
    }
    case 'VarRef': {
      const value = await env.get(formula.varIdx);
      if (value.type !== 'Static') {
        throw new Error('Dynamic value used in formula');
      }
      const [decoded] = decodeAbiParameters([{ type: 'uint256' }], value.encoding);
      return decoded;
    }
  }
}
