import type { AbiType, AbiTypeToPrimitiveType } from 'abitype';
import type { Hex, Address, PublicClient } from 'viem';
import { parseAbi, toHex, decodeFunctionData, slice, concat, encodeAbiParameters, decodeAbiParameters, size, hexToNumber, hexToBigInt, numberToHex, getAddress } from 'viem';

function toSafeNumber(value: bigint): number {
  const num = Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Number out of safe integer range: ${value.toString()}`);
  }
  return num;
}

class UnresolvedVariableError extends Error {
  varIdx: number;
  role: VariableRole;

  constructor(varIdx: number, role: VariableRole) {
    super(`Variable ${varIdx} (${role.type}) not set`);
    this.varIdx = varIdx;
    this.role = role;
  }
}

interface Account {
  address: Address;
  chainId: bigint;
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

interface ResolvedOrder {
  steps: Step[];
  variables: VariableRole[];
  assumptions: Assumption[];
  payments: Payment[];
}

type Step = Step_Call;

interface Step_Call {
  type: 'Call';
  target: Account;
  selector: Hex; // bytes4
  arguments: Argument[];
  attributes: Attribute[];
  dependencySteps: number[]; // Steps by index in resolved order
  payments: Payment[];
}

type Attribute =
  | Attribute_SpendsERC20
  | Attribute_SpendsEstimatedGas
  | Attribute_OnlyBefore
  | Attribute_OnlyFillerUntil
  | Attribute_OnlyWhenCallResult
  | Attribute_UnlessRevert
  | Attribute_WithTimestamp
  | Attribute_WithBlockNumber
  | Attribute_WithEffectiveGasPrice
  | Attribute_WithLog;

interface Attribute_SpendsERC20 {
  type: 'SpendsERC20';
  token: Account;
  amountFormula: Formula;
  spender: Account;
}

interface Attribute_SpendsEstimatedGas {
  type: 'SpendsEstimatedGas';
  amountFormula: Formula;
}

interface Attribute_OnlyBefore {
  type: 'OnlyBefore';
  deadline: bigint;
}

interface Attribute_OnlyFillerUntil {
  type: 'OnlyFillerUntil';
  exclusiveFiller: Address;
  deadline: bigint;
}

interface Attribute_OnlyWhenCallResult {
  type: 'OnlyWhenCallResult';
  target: Account;
  selector: Hex; // bytes4
  arguments: Argument[];
  result: Hex;
  maxGasCost: bigint;
}

interface Attribute_UnlessRevert {
  type: 'UnlessRevert';
  reason: Hex;
}

interface Attribute_WithTimestamp {
  type: 'WithTimestamp';
  timestampVarIdx: number;
}

interface Attribute_WithBlockNumber {
  type: 'WithBlockNumber';
  blockNumberVarIdx: number;
}

interface Attribute_WithEffectiveGasPrice {
  type: 'WithEffectiveGasPrice';
  gasPriceVarIdx: number;
}

interface Attribute_WithLog {
  type: 'WithLog';
  mask: Hex; // bytes1
  topicVarIdxs: number[];
  dataVarIdx: number;
}

type Formula = Formula_Const | Formula_VarRef;

interface Formula_Const {
  type: 'Const';
  val: bigint;
}

interface Formula_VarRef {
  type: 'VarRef';
  varIdx: number;
}

type Payment = Payment_ERC20;

interface Payment_ERC20 {
  type: 'ERC20';
  token: Account;
  amountFormula: Formula;
  recipientVarIdx: number;
  estimatedDelaySeconds: bigint;
}

type VariableRole =
  | VariableRole_PaymentRecipient
  | VariableRole_PaymentChain
  | VariableRole_Pricing
  | VariableRole_TxOutput
  | VariableRole_Witness
  | VariableRole_Query;

interface VariableRole_PaymentRecipient {
  type: 'PaymentRecipient';
  chainId: bigint;
}

interface VariableRole_PaymentChain {
  type: 'PaymentChain';
}

interface VariableRole_Pricing {
  type: 'Pricing';
}

interface VariableRole_TxOutput {
  type: 'TxOutput';
}

interface VariableRole_Witness {
  type: 'Witness';
  kind: string;
  data: Hex;
  variables: number[];
}

interface VariableRole_Query {
  type: 'Query';
  target: Account;
  selector: Hex; // bytes4
  arguments: Argument[];
  blockNumber: bigint;
}

interface Assumption {
  trusted: Account;
  kind: string;
}

type Argument = Argument_AbiWrappedValue | Argument_Variable;

interface Argument_AbiWrappedValue {
  type: 'AbiWrappedValue';
  value: AbiWrappedValue;
}

interface Argument_Variable {
  type: 'Variable';
  varIdx: number;
}

interface AbiWrappedValue {
  type: 'Static' | 'Dynamic';
  encoding: Hex;
}

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

function decodeArgument(encoded: Hex): Argument {
  if (size(encoded) === 32) {
    // Variable: decode as index
    const varIdx = hexToNumber(encoded);
    return { type: 'Variable', varIdx };
  } else {
    return { type: 'AbiWrappedValue', value: decodeAbiWrappedValue(encoded) };
  }
}

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

const DYN_PREFIX = concat([
  '0x0000000000000000000000000000000000000000000000000000000000000040',
  '0x0000000000000000000000000000000000000000000000000000000000000060',
  '0x0000000000000000000000000000000000000000000000000000000000000000',
]);

function decodeAbiWrappedValue(encoded: Hex): AbiWrappedValue {
  if (encoded.startsWith(DYN_PREFIX)) {
    const encoding = slice(encoded, size(DYN_PREFIX));
    return { type: 'Dynamic', encoding };
  } else {
    // Static: format is [32-byte size][encoding][32-byte zero padding]
    const lengthHex = slice(encoded, 0, 32);
    const length = hexToNumber(lengthHex);
    const expectedLength = length + 64;

    if (size(encoded) !== expectedLength) {
      throw new Error('Invalid static argument length');
    }

    const padding = slice(encoded, expectedLength - 32, expectedLength);
    if (padding !== ZERO) {
      throw new Error('Missing static argument end marker');
    }

    const encoding = slice(encoded, 32, expectedLength - 32);
    return { type: 'Static', encoding };
  }
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
      const _: readonly [] = decoded.args;
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

const resolverAbi = parseAbi([
  'function resolve(bytes payload) view returns (ResolvedOrder)',
  'struct ResolvedOrder { bytes[] steps; bytes[] variables; Assumption[] assumptions; bytes[] payments; }',
  'struct Assumption { bytes trusted; string kind; }',
]);

const stepAbi = parseAbi([
  'function Call(bytes target, bytes4 selector, bytes[] arguments, bytes[] attributes, uint256[] dependencySteps, bytes[] payments) external',
]);

const attributeAbi = parseAbi([
  'function SpendsERC20(bytes token, bytes amountFormula, bytes spender) external',
  'function SpendsEstimatedGas(bytes amountFormula) external',
  'function OnlyBefore(uint256 deadline) external',
  'function OnlyFillerUntil(address exclusiveFiller, uint256 deadline) external',
  'function OnlyWhenCallResult(bytes target, bytes4 selector, bytes[] arguments, bytes result, uint256 maxGasCost) external',
  'function UnlessRevert(bytes reason) external',
  'function WithTimestamp(uint256 timestampVarIdx) external',
  'function WithBlockNumber(uint256 blockNumberVarIdx) external',
  'function WithEffectiveGasPrice(uint256 gasPriceVarIdx) external',
  'function WithLog(bytes1 mask, uint256[] topicVarIdxs, uint256 dataVarIdx) external',
]);

const formulaAbi = parseAbi([
  'function Const(uint256 val) external',
  'function VarRef(uint256 varIdx) external',
]);

const paymentAbi = parseAbi([
  'function ERC20(bytes token, bytes amountFormula, uint256 recipientVarIdx, uint256 estimatedDelaySeconds) external',
]);

const variableRoleAbi = parseAbi([
  'function PaymentRecipient(uint256 chainId) external',
  'function PaymentChain() external',
  'function Pricing() external',
  'function TxOutput() external',
  'function Witness(string kind, bytes data, uint256[] variables) external',
  'function Query(bytes target, bytes4 selector, bytes[] arguments, uint256 blockNumber) external',
]);

export interface SolverContext {
  getClient: (chainId: bigint) => PublicClient;
  paymentChain: bigint;
  paymentRecipient: (chainId: bigint) => Address;
  fillerAddress: Address;
  isWhitelisted: (account: Account, assumption: string) => boolean;
  getWitnessResolver: (kind: string) => WitnessResolver | undefined;
  getTokenPriceUsd: (token: Account) => bigint;
  getGasPriceUsd: (chainId: bigint) => bigint;
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

// =============================================================================
// QUOTING & FILLING PLAN
// =============================================================================
//
// Outer loop (ingestion):
//   for order in orders:
//     if deadlinePassed(order) → skip              // check OnlyBefore attributes
//     quoteResult = quote(ctx, order)              // throws on unsupported orders
//     if !hasInventory(quoteResult) → skip         // post-quote inventory check
//     if exceedsRiskLimits(...) → skip
//     fill(ctx, order, quoteResult)                // returns promise, tracked implicitly
//
// quote(ctx, order) → QuoteResult
//   1. Validate: check assumptions whitelisted, witness kinds supported
//   2. Build env + collect flows:
//      - env: lazy, tick-validated VariableEnv
//      - flows: Token/Gas AssetFlow[]
//      - gas flow per step:
//        - SpendsEstimatedGas → amount set
//        - otherwise amount unset (needs simulation later)
//   3. Collect pricing vars and reject if any exist (pricing not handled yet)
//   4. Compute profit + inventory (TODO)
//
// fill(ctx, order, quoteResult) → ...
//   1. Resolve remaining variables on demand via env.get(...)
//   2. Execute steps in dependency order
//   3. Resolve Witnesses mid-execution via ctx.getWitnessResolver
//   4. Extract TxOutput variables from receipts
//   5. TX management handwaved for now (nonces, gas, retries)
//   6. State tracked implicitly via in-memory promises
//
// =============================================================================

interface WitnessResolver {
  resolve(data: Hex, variableValues: AbiWrappedValue[]): Promise<AbiWrappedValue>;
}

interface QuoteResult {
  env: VariableEnv; // resolved variables, passed to fill
}

export async function quote(
  ctx: SolverContext,
  order: ResolvedOrder,
): Promise<QuoteResult> {
  for (const assumption of order.assumptions) {
    if (!ctx.isWhitelisted(assumption.trusted, assumption.kind)) {
      throw new Error(`Unsupported assumption '${assumption.kind}'`);
    }
  }

  for (const variable of order.variables) {
    if (variable.type === 'Witness' && !ctx.getWitnessResolver(variable.kind)) {
      throw new Error(`Unsupported witness kind '${variable.kind}'`);
    }
  }

  const env = new VariableEnv(ctx, order.variables);
  const pricingVars = collectPricingVars(order);
  if (pricingVars.length !== 0) {
    throw new Error('Pricing variables not supported');
  }

  const flowFormulas = collectFlowFormulas(order);
  const flowAmounts = await computeFlowAmounts(ctx, env, flowFormulas);
  const pnlUsd = computePnLUsd(ctx, flowAmounts);
  if (pnlUsd < 0n) {
    throw new Error('Negative PnL');
  }

  return { env };
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

type AssetFlow<TAmount> = TokenFlow<TAmount> | GasFlow<TAmount>;

function collectPricingVars(order: ResolvedOrder): number[] {
  const pricingVars: number[] = [];
  for (let i = 0; i < order.variables.length; i++) {
    if (order.variables[i]?.type === 'Pricing') {
      pricingVars.push(i);
    }
  }
  return pricingVars;
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

// =============================================================================

interface CallSpec {
  target: Account;
  selector: Hex;
  arguments: Argument[];
  blockNumber?: bigint;
}

async function buildCallArgs(env: VariableEnv, args: Argument[]): Promise<AbiWrappedValue[]> {
  const argValues: AbiWrappedValue[] = [];
  for (const arg of args) {
    if (arg.type === 'Variable') {
      argValues.push(await env.get(arg.varIdx));
    } else {
      argValues.push(arg.value);
    }
  }
  return argValues;
}

async function envCall(
  ctx: SolverContext,
  env: VariableEnv,
  spec: CallSpec,
): Promise<Hex> {
  const argValues = await buildCallArgs(env, spec.arguments);
  const client = ctx.getClient(spec.target.chainId);
  const result = await client.call({
    to: spec.target.address,
    data: abiEncodeFunctionCall(spec.selector, argValues),
    blockNumber: spec.blockNumber,
  });
  return result.data ?? '0x';
}

async function envSimulateCall(
  ctx: SolverContext,
  env: VariableEnv,
  spec: CallSpec,
): Promise<{ gasUsed: bigint; status: 'success' | 'failure' }> {
  const argValues = await buildCallArgs(env, spec.arguments);
  const client = ctx.getClient(spec.target.chainId);
  const { results } = await client.simulateCalls({
    account: ctx.fillerAddress,
    blockNumber: spec.blockNumber,
    calls: [{ to: spec.target.address, data: abiEncodeFunctionCall(spec.selector, argValues) }],
  });
  const [result] = results;
  if (!result) {
    throw new Error('simulateCalls returned no results');
  }
  return { gasUsed: result.gasUsed, status: result.status };
}

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
        throw new UnresolvedVariableError(varIdx, role);
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

function abiWrap<const T extends AbiType>(value: AbiTypeToPrimitiveType<T>, type: T): AbiWrappedValue {
  return decodeAbiWrappedValue(
    // @ts-ignore
    encodeAbiParameters([{ type: 'string' }, { type }], ["", value])
  );
}
