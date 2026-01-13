import type { Hex, Address, PublicClient } from 'viem';
import { decodeFunctionData, getAddress, toHex, hexToBigInt, hexToNumber, size, slice } from 'viem';
import type { ResolvedOrder, Account, Argument, Attribute, Formula, Payment, Step, VariableRole } from './types.ts';
import { resolverAbi, attributeAbi, formulaAbi, paymentAbi, stepAbi, variableRoleAbi } from './abis.ts';
import { decodeAbiWrappedValue } from './abi-wrap.ts';

export async function resolve(client: PublicClient, resolver: Address, payload: Uint8Array): Promise<ResolvedOrder> {
  const result = await client.readContract({
    address: resolver,
    abi: resolverAbi,
    functionName: 'resolve',
    args: [toHex(payload)],
  });

  return {
    steps: result.steps.map(decodeStep),
    variables: result.variables.map(decodeVariableRole),
    assumptions: result.assumptions.map(a => ({ trusted: decodeERC7930Address(a.trusted), kind: a.kind })),
    payments: result.payments.map(decodePayment),
  };
}

function decodeStep(data: Hex): Step {
  const decoded = decodeFunctionData({ abi: stepAbi, data });

  switch (decoded.functionName) {
    case 'Call': {
      const [target, selector, arguments_, attributes, dependencySteps, payments] =
        decoded.args;
      return {
        type: 'Call',
        target: decodeERC7930Address(target),
        selector,
        arguments: arguments_.map(decodeArgument),
        attributes: attributes.map(decodeAttribute),
        dependencySteps: dependencySteps.map(toSafeNumber),
        payments: payments.map(decodePayment),
      };
    }
  }
}

function decodeArgument(encoded: Hex): Argument {
  if (size(encoded) === 32) {
    // Variable: decode as index
    const varIdx = hexToNumber(encoded);
    return { type: 'Variable', varIdx };
  } else {
    return { type: 'AbiWrappedValue', value: decodeAbiWrappedValue(encoded) };
  }
}

function decodeAttribute(encoded: Hex): Attribute {
  const decoded = decodeFunctionData({ abi: attributeAbi, data: encoded });

  switch (decoded.functionName) {
    case 'SpendsERC20': {
      const [token, amountFormula, spender] = decoded.args;
      return {
        type: 'SpendsERC20',
        token: decodeERC7930Address(token),
        amountFormula: decodeFormula(amountFormula),
        spender: decodeERC7930Address(spender),
      };
    }
    case 'SpendsEstimatedGas': {
      const [amountFormula] = decoded.args;
      return {
        type: 'SpendsEstimatedGas',
        amountFormula: decodeFormula(amountFormula),
      };
    }
    case 'OnlyBefore': {
      const [deadline] = decoded.args;
      return { type: 'OnlyBefore', deadline };
    }
    case 'OnlyFillerUntil': {
      const [exclusiveFiller, deadline] = decoded.args;
      return { type: 'OnlyFillerUntil', exclusiveFiller, deadline };
    }
    case 'OnlyWhenCallResult': {
      const [target, selector, arguments_, result, maxGasCost] = decoded.args;
      return {
        type: 'OnlyWhenCallResult',
        target: decodeERC7930Address(target),
        selector,
        arguments: arguments_.map(decodeArgument),
        result,
        maxGasCost,
      };
    }
    case 'UnlessRevert': {
      const [reason] = decoded.args;
      return { type: 'UnlessRevert', reason };
    }
    case 'WithTimestamp': {
      const [timestampVarIdx] = decoded.args;
      return { type: 'WithTimestamp', timestampVarIdx: toSafeNumber(timestampVarIdx) };
    }
    case 'WithBlockNumber': {
      const [blockNumberVarIdx] = decoded.args;
      return { type: 'WithBlockNumber', blockNumberVarIdx: toSafeNumber(blockNumberVarIdx) };
    }
    case 'WithEffectiveGasPrice': {
      const [gasPriceVarIdx] = decoded.args;
      return { type: 'WithEffectiveGasPrice', gasPriceVarIdx: toSafeNumber(gasPriceVarIdx) };
    }
    case 'WithLog': {
      const [mask, topicVarIdxs, dataVarIdx] = decoded.args;
      return {
        type: 'WithLog',
        mask,
        topicVarIdxs: topicVarIdxs.map(toSafeNumber),
        dataVarIdx: toSafeNumber(dataVarIdx),
      };
    }
  }
}

function decodeFormula(encoded: Hex): Formula {
  const decoded = decodeFunctionData({ abi: formulaAbi, data: encoded });

  switch (decoded.functionName) {
    case 'Const': {
      const [val] = decoded.args;
      return { type: 'Const', val };
    }
    case 'VarRef': {
      const [varIdx] = decoded.args;
      return { type: 'VarRef', varIdx: toSafeNumber(varIdx) };
    }
  }
}

function decodeVariableRole(encoded: Hex): VariableRole {
  const decoded = decodeFunctionData({ abi: variableRoleAbi, data: encoded });

  switch (decoded.functionName) {
    case 'PaymentRecipient': {
      const [chainId] = decoded.args;
      return { type: 'PaymentRecipient', chainId };
    }
    case 'Witness': {
      const [kind, data, variables] = decoded.args;
      return { type: 'Witness', kind, data, variables: variables.map(toSafeNumber) };
    }
    case 'Query': {
      const [target, selector, arguments_, blockNumber] = decoded.args;
      return { type: 'Query', target: decodeERC7930Address(target), selector, arguments: arguments_.map(decodeArgument), blockNumber };
    }
    default: {
      decoded.args satisfies readonly [];
      return { type: decoded.functionName };
    }
  }
}

function decodePayment(encoded: Hex): Payment {
  const decoded = decodeFunctionData({ abi: paymentAbi, data: encoded });

  switch (decoded.functionName) {
    case 'ERC20': {
      const [token, amountFormula, recipientVarIdx, estimatedDelaySeconds] =
        decoded.args;
      return {
        type: 'ERC20',
        token: decodeERC7930Address(token),
        amountFormula: decodeFormula(amountFormula),
        recipientVarIdx: toSafeNumber(recipientVarIdx),
        estimatedDelaySeconds,
      };
    }
  }
}

// ERC-7930 binary format:
// - version: 2 bytes
// - chainType: 2 bytes
// - chainRefLen: 1 byte
// - chainRef: N bytes
// - addrLen: 1 byte
// - address: M bytes
function decodeERC7930Address(binary: Hex): Account {
  const version = slice(binary, 0, 2);
  if (version !== '0x0001') {
    throw new Error(`Unsupported ERC-7930 version: ${version}`);
  }
  const chainType = slice(binary, 2, 4);
  if (chainType !== '0x0000') {
    throw new Error(`Unsupported chain type: ${chainType}`);
  }
  const chainRefLen = hexToNumber(slice(binary, 4, 5));
  const chainRef = slice(binary, 5, 5 + chainRefLen);
  const addrLen = hexToNumber(slice(binary, 5 + chainRefLen, 6 + chainRefLen));
  const address = getAddress(slice(binary, 6 + chainRefLen, 6 + chainRefLen + addrLen));
  const chainId = hexToBigInt(chainRef);
  return { address, chainId };
}

function toSafeNumber(value: bigint): number {
  const num = Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Number out of safe integer range: ${value.toString()}`);
  }
  return num;
}
