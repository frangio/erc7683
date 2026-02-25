import { concat, decodeAbiParameters, numberToHex, size, type Hex } from 'viem';
import type { Account, Argument, Formula, VariableRole } from './types.ts';
import type { SolverContext } from './context.ts';
import { abiEncode, decodeAbiWrappedValue, type AbiEncodedValue } from './abi-wrap.ts';

// Assumes resolver does not create dependency cycles between variables.
export class VariableEnv {
  private ctx: SolverContext;
  private roles: VariableRole[];
  private cache: { value?: Promise<AbiEncodedValue>; tick: number }[];
  private tick = 0;

  constructor(ctx: SolverContext, roles: VariableRole[]) {
    this.ctx = ctx;
    this.roles = roles;
    this.cache = roles.map(() => ({ tick: -1 }));
  }

  set(varIdx: number, value: AbiEncodedValue): void {
    const role = this.roles[varIdx]!;
    switch (role.type) {
      case 'Pricing':
      case 'TxOutput':
      case 'Witness': {
        this.cache[varIdx] = { value: Promise.resolve(value), tick: this.tick++ };
        break;
      }

      default: {
        throw new Error(`Variable ${varIdx} (${role.type}) cannot be set`);
      }
    }
  }

  async get(varIdx: number): Promise<AbiEncodedValue> {
    if (this.isFresh(varIdx)) {
      return this.cache[varIdx]!.value!;
    }
    const value = this.recompute(varIdx);
    this.cache[varIdx] = { value, tick: this.tick++ };
    return value;
  }

  private async recompute(varIdx: number): Promise<AbiEncodedValue> {
    const role = this.roles[varIdx]!;

    switch (role.type) {
      case 'PaymentChain': {
        return abiEncode(this.ctx.paymentChain, 'uint256');
      }

      case 'PaymentRecipient': {
        return abiEncode(this.ctx.paymentRecipient(role.chainId), 'address');
      }

      case 'Query': {
        return decodeAbiWrappedValue(await envCall(this.ctx, this, role));
      }

      case 'QueryEvents': {
        throw new Error('TODO');
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
  const client = ctx.getPublicClient(spec.target.chainId);
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
  const client = ctx.getPublicClient(spec.target.chainId);
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

export async function buildCallData(env: VariableEnv, spec: CallSpec): Promise<Hex> {
  const argValues = await Promise.all(spec.arguments.map(async arg => {
    switch (arg.type) {
      case 'Variable': return env.get(arg.varIdx);
      case 'AbiEncodedValue': return arg.value;
    }
  }));
  return abiEncodeFunctionCall(spec.selector, argValues);
}

export function abiEncodeFunctionCall(selector: Hex, abiEncodedValues: AbiEncodedValue[]): Hex {
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

export async function envEval(env: VariableEnv, formula: Formula): Promise<bigint> {
  switch (formula.type) {
    case 'Constant': {
      return formula.value;
    }
    case 'Variable': {
      const value = await env.get(formula.varIdx);
      if (value.type !== 'Static') {
        throw new Error('Dynamic value used in formula');
      }
      const [decoded] = decodeAbiParameters([{ type: 'uint256' }], value.encoding);
      return decoded;
    }
  }
}
