import { decodeAbiParameters, isAddressEqual, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import type { SolverContext } from './context.ts';
import { buildCallData } from './env.ts';
import { abiEncode } from './abi-wrap.ts';
import type { VariableEnv } from './env.ts';
import type { Attributes, ResolvedOrder, Step } from './types.ts';

class ResolverError extends Error {
  constructor() { super("resolver error") }
}

export async function fill(
  ctx: SolverContext,
  order: ResolvedOrder,
  env: VariableEnv,
): Promise<boolean> {
  for (const step of order.steps) {
    await resolveStepWitnesses(ctx, env, order, step);
    const shouldContinue = await executeStep(ctx, env, step);
    if (!shouldContinue) return false;
  }

  return true;
}

async function executeStep(
  ctx: SolverContext,
  env: VariableEnv,
  step: Step,
): Promise<boolean> {
  switch (step.type) {
    case 'Call': {
      const executionTimestamp = await getStepExecutionTimestamp(ctx, env, step);
      if (executionTimestamp !== undefined) {
        await sleepUntilTimestamp(executionTimestamp);
      }

      const walletClient = ctx.getWalletClient(step.target.chainId);
      const publicClient = ctx.getPublicClient(step.target.chainId);

      const callData = await buildCallData(env, step);

      let revertData = await simulateRevert(
        publicClient,
        ctx.fillerAddress,
        step.target.address,
        callData,
      );

      if (!revertData) {
        const txhash = await walletClient.sendTransaction({
          account: ctx.fillerAddress,
          to: step.target.address,
          data: callData,
        });

        // TODO: consider reorgs
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txhash });

        if (receipt.status === 'success') {
          await applyTxOutputs(env, publicClient, receipt, step.attributes);
        } else {
          revertData = await simulateRevert(
            publicClient,
            ctx.fillerAddress,
            step.target.address,
            callData,
            receipt.blockNumber,
          );

          if (!revertData) throw new ResolverError();
        }
      }

      if (revertData) {
        switch (getMatchingRevertPolicy(step, revertData)) {
          case 'drop':
            return false;
          case 'ignore':
            return true;
          default:
            throw new ResolverError();
        }
      }

      return true;
    }
  }
}

async function getStepExecutionTimestamp(
  ctx: SolverContext,
  env: VariableEnv,
  step: Step,
): Promise<bigint | undefined> {
  if (step.type !== 'Call') {
    return undefined;
  }

  let executionTimestamp: bigint | undefined;

  if (step.attributes.WithTimestamp) {
    const timestampEncoding = await env.get(step.attributes.WithTimestamp.timestampVarIdx).catch(() => undefined);
    if (timestampEncoding?.type === 'Static') {
      const [timestamp] = decodeAbiParameters([{ type: 'uint256' }], timestampEncoding.encoding);
      executionTimestamp = timestamp;
    }
  }

  const requiredFillerUntil = step.attributes.RequiredFillerUntil;
  if (requiredFillerUntil && !isAddressEqual(requiredFillerUntil.exclusiveFiller, ctx.fillerAddress)) {
    if (executionTimestamp === undefined || requiredFillerUntil.deadline > executionTimestamp) {
      executionTimestamp = requiredFillerUntil.deadline;
    }
  }

  return executionTimestamp;
}

async function sleepUntilTimestamp(timestampSeconds: bigint): Promise<void> {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (nowSeconds >= timestampSeconds) return;
  const sleepMs = Number((timestampSeconds - nowSeconds) * 1000n);
  await new Promise(resolve => setTimeout(resolve, sleepMs));
}

async function simulateRevert(
  publicClient: PublicClient,
  account: Address,
  to: Address,
  data: Hex,
  blockNumber?: bigint,
): Promise<Hex | undefined> {
  const { results: [result] } = await publicClient.simulateCalls({
    account,
    blockNumber,
    calls: [{ to, data }],
  });
  return result?.status === 'failure' ? result.data : undefined;
}

function getMatchingRevertPolicy(step: Step, revertData: Hex): 'drop' | 'ignore' | 'retry' | undefined {
  const revertDataLower = revertData.toLowerCase();
  return step.attributes.RevertPolicy.find(policy => revertDataLower.startsWith(policy.expectedReason.toLowerCase()))?.policy;
}

async function resolveStepWitnesses(
  ctx: SolverContext,
  env: VariableEnv,
  order: ResolvedOrder,
  step: Step,
): Promise<void> {
  for (const arg of step.arguments) {
    if (arg.type !== 'Variable') continue;
    const role = order.variables[arg.varIdx];
    if (role?.type !== 'Witness') continue;
    const resolver = ctx.getWitnessResolver(role.kind);
    if (!resolver) throw new Error(`Unsupported witness kind '${role.kind}'`);
    const values = await Promise.all(role.variables.map(varIdx => env.get(varIdx)));
    const resolved = await resolver.resolve(role.data, values);
    env.set(arg.varIdx, resolved);
  }
}

async function applyTxOutputs(
  env: VariableEnv,
  publicClient: PublicClient,
  receipt: TransactionReceipt,
  attributes: Attributes,
): Promise<void> {
  if (attributes.WithBlockNumber) {
    env.set(attributes.WithBlockNumber.blockNumberVarIdx, abiEncode(receipt.blockNumber, 'uint256'));
  }

  if (attributes.WithTimestamp) {
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    env.set(attributes.WithTimestamp.timestampVarIdx, abiEncode(block.timestamp, 'uint256'));
  }

  if (attributes.WithEffectiveGasPrice) {
    const gasPrice = receipt.effectiveGasPrice;
    env.set(attributes.WithEffectiveGasPrice.gasPriceVarIdx, abiEncode(gasPrice, 'uint256'));
  }
}
