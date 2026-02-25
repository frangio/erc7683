import type { Hex, Address, PublicClient } from 'viem';
import { decodeFunctionData, getAddress, toHex, hexToBigInt, hexToNumber, size, slice } from 'viem';
import type { Attributes, Attribute, ResolvedOrder, Account, Argument, Formula, Payment, Step, VariableRole } from './types.ts';
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
      const [target, selector, arguments_, attributes, payments] =
        decoded.args;
      return {
        type: 'Call',
        target: decodeERC7930Address(target),
        selector,
        arguments: arguments_.map(decodeArgument),
        attributes: decodeAttributes(attributes),
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
    return { type: 'AbiEncodedValue', value: decodeAbiWrappedValue(encoded) };
  }
}

function decodeAttribute(encoded: Hex): Attribute {
  const decoded = decodeFunctionData({ abi: attributeAbi, data: encoded });

  switch (decoded.functionName) {
    case 'SpendsERC20': {
      const [token, amountFormula, spender, receiver] = decoded.args;
      return {
        type: 'SpendsERC20',
        token: decodeERC7930Address(token),
        amountFormula: decodeFormula(amountFormula),
        spender: decodeERC7930Address(spender),
        receiver: decodeERC7930Address(receiver),
      };
    }
    case 'SpendsEstimatedGas': {
      const [amountFormula] = decoded.args;
      return {
        type: 'SpendsEstimatedGas',
        amountFormula: decodeFormula(amountFormula),
      };
    }
    case 'RequiredBefore': {
      const [deadline] = decoded.args;
      return { type: 'RequiredBefore', deadline };
    }
    case 'RequiredFillerUntil': {
      const [exclusiveFiller, deadline] = decoded.args;
      return { type: 'RequiredFillerUntil', exclusiveFiller, deadline };
    }
    case 'RequiredCallResult': {
      const [target, selector, arguments_, result] = decoded.args;
      return {
        type: 'RequiredCallResult',
        target: decodeERC7930Address(target),
        selector,
        arguments: arguments_.map(decodeArgument),
        result,
      };
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
  }
}

function decodeAttributes(encoded: readonly Hex[]): Attributes {
  const attributes: Attributes = { SpendsERC20: [], RevertPolicy: [] };

  for (const entry of encoded) {
    const decoded = decodeAttribute(entry);
    if (decoded.type === 'SpendsERC20') {
      attributes.SpendsERC20.push(decoded);
    } else if (decoded.type === 'RevertPolicy') {
      attributes.RevertPolicy.push(decoded);
    } else {
      if (decoded.type in attributes) {
        throw new Error(`Multiple ${decoded.type} attributes`);
      }
      /// @ts-ignore: TypeScript is not able to type this
      attributes[decoded.type] = decoded;
    }
  }

  return attributes;
}

function decodeFormula(encoded: Hex): Formula {
  const decoded = decodeFunctionData({ abi: formulaAbi, data: encoded });

  switch (decoded.functionName) {
    case 'Constant': {
      const [value] = decoded.args;
      return { type: 'Constant', value };
    }
    case 'Variable': {
      const [varIdx] = decoded.args;
      return { type: 'Variable', varIdx: toSafeNumber(varIdx) };
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
      const [token, sender, amountFormula, recipientVarIdx, estimatedDelaySeconds] =
        decoded.args;
      return {
        type: 'ERC20',
        token: decodeERC7930Address(token),
        sender: decodeERC7930Address(sender),
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
