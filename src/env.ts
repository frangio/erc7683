import { concat, numberToHex, size, type Hex } from 'viem';
import type { Account, Argument, VariableRole } from './types.ts';
import type { SolverContext } from './context.ts';
import { abiWrap, decodeAbiWrappedValue, type AbiWrappedValue } from './abi-wrap.ts';

// Assumes resolver does not create dependency cycles between variables.
export class VariableEnv {
  private ctx: SolverContext;
  private roles: VariableRole[];
  private cache: { value?: Promise<AbiWrappedValue>; tick: number }[];
  private tick = 0;

  constructor(ctx: SolverContext, roles: VariableRole[]) {
    this.ctx = ctx;
    this.roles = roles;
    this.cache = roles.map(() => ({ tick: -1 }));
  }

  set(varIdx: number, value: AbiWrappedValue): void {
    this.cache[varIdx] = { value: Promise.resolve(value), tick: this.tick++ };
  }

  async get(varIdx: number): Promise<AbiWrappedValue> {
    if (this.isFresh(varIdx)) {
      return this.cache[varIdx]!.value!;
    }
    const value = this.recompute(varIdx);
    this.cache[varIdx] = { value, tick: this.tick++ };
    return value;
  }

  private async recompute(varIdx: number): Promise<AbiWrappedValue> {
    const role = this.roles[varIdx]!;

    switch (role.type) {
      case 'PaymentChain': {
        return abiWrap(this.ctx.paymentChain, 'uint256');
      }

      case 'PaymentRecipient': {
        return abiWrap(this.ctx.paymentRecipient(role.chainId), 'address');
      }

      case 'Query': {
        return decodeAbiWrappedValue(await envCall(this.ctx, this, role));
      }

      case 'Pricing':
      case 'TxOutput':
      case 'Witness': {
        throw new Error(`Variable ${varIdx} (${role.type}) not set`);
      }
    }
  }

  isFresh(varIdx: number): boolean {
    const { value, tick } = this.cache[varIdx]!;
    if (!value) {
      return false;
    }
    for (const depIdx of this.deps(varIdx)) {
      const depTick = this.cache[depIdx]!.tick;
      if (depTick > tick || !this.isFresh(depIdx)) {
        return false;
      }
    }
    return true;
  }

  *deps(varIdx: number): Iterable<number> {
    const role = this.roles[varIdx]!;
    if (role.type === 'Query') {
      for (const arg of role.arguments) {
        if (arg.type === 'Variable') {
          yield arg.varIdx;
        }
      }
    }
  }
}

interface CallSpec {
  target: Account;
  selector: Hex;
  arguments: Argument[];
  blockNumber?: bigint;
}

export async function envCall(
  ctx: SolverContext,
  env: VariableEnv,
  spec: CallSpec,
): Promise<Hex> {
  const client = ctx.getClient(spec.target.chainId);
  const data = await buildCallData(env, spec);
  const result = await client.call({
    to: spec.target.address,
    data,
    blockNumber: spec.blockNumber,
  });
  return result.data ?? '0x';
}

export async function envSimulateCall(
  ctx: SolverContext,
  env: VariableEnv,
  spec: CallSpec,
): Promise<{ gasUsed: bigint; status: 'success' | 'failure' }> {
  const client = ctx.getClient(spec.target.chainId);
  const data = await buildCallData(env, spec);
  const { results } = await client.simulateCalls({
    account: ctx.fillerAddress,
    blockNumber: spec.blockNumber,
    calls: [{ to: spec.target.address, data }],
  });
  const [result] = results;
  if (!result) {
    throw new Error('simulateCalls returned no results');
  }
  return { gasUsed: result.gasUsed, status: result.status };
}

async function buildCallData(env: VariableEnv, spec: CallSpec): Promise<Hex> {
  const argValues: AbiWrappedValue[] = [];
  for (const arg of spec.arguments) {
    if (arg.type === 'Variable') {
      argValues.push(await env.get(arg.varIdx));
    } else {
      argValues.push(arg.value);
    }
  }
  return abiEncodeFunctionCall(spec.selector, argValues);
}

export function abiEncodeFunctionCall(selector: Hex, abiEncodedValues: AbiWrappedValue[]): Hex {
  if (size(selector) !== 4) {
    throw new Error('Selector must be 4 bytes');
  }

  const heads: Hex[] = [];
  const tails: Hex[] = [];

  let nextDynHead = 0;
  for (const v of abiEncodedValues) {
    nextDynHead += v.type === 'Dynamic' ? 32 : size(v.encoding);
  }

  for (const v of abiEncodedValues) {
    if (v.type === 'Dynamic') {
      tails.push(v.encoding);
      heads.push(numberToHex(nextDynHead, { size: 32 }));
      nextDynHead += size(v.encoding);
    } else {
      heads.push(v.encoding);
    }
  }

  return concat([selector, ...heads, ...tails]);
}
