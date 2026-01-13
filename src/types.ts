import type { Address, Hex } from 'viem';
import type { AbiWrappedValue } from './abi-wrap.ts';

export interface ResolvedOrder {
  steps: Step[];
  variables: VariableRole[];
  assumptions: Assumption[];
  payments: Payment[];
}

export interface Account {
  address: Address;
  chainId: bigint;
}

export type Step = Step_Call;

export interface Step_Call {
  type: 'Call';
  target: Account;
  selector: Hex; // bytes4
  arguments: Argument[];
  attributes: Attribute[];
  dependencySteps: number[]; // Steps by index in resolved order
  payments: Payment[];
}

export type Attribute =
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

export interface Attribute_SpendsERC20 {
  type: 'SpendsERC20';
  token: Account;
  amountFormula: Formula;
  spender: Account;
}

export interface Attribute_SpendsEstimatedGas {
  type: 'SpendsEstimatedGas';
  amountFormula: Formula;
}

export interface Attribute_OnlyBefore {
  type: 'OnlyBefore';
  deadline: bigint;
}

export interface Attribute_OnlyFillerUntil {
  type: 'OnlyFillerUntil';
  exclusiveFiller: Address;
  deadline: bigint;
}

export interface Attribute_OnlyWhenCallResult {
  type: 'OnlyWhenCallResult';
  target: Account;
  selector: Hex; // bytes4
  arguments: Argument[];
  result: Hex;
  maxGasCost: bigint;
}

export interface Attribute_UnlessRevert {
  type: 'UnlessRevert';
  reason: Hex;
}

export interface Attribute_WithTimestamp {
  type: 'WithTimestamp';
  timestampVarIdx: number;
}

export interface Attribute_WithBlockNumber {
  type: 'WithBlockNumber';
  blockNumberVarIdx: number;
}

export interface Attribute_WithEffectiveGasPrice {
  type: 'WithEffectiveGasPrice';
  gasPriceVarIdx: number;
}

export interface Attribute_WithLog {
  type: 'WithLog';
  mask: Hex; // bytes1
  topicVarIdxs: number[];
  dataVarIdx: number;
}

export type Formula = Formula_Const | Formula_VarRef;

export interface Formula_Const {
  type: 'Const';
  val: bigint;
}

export interface Formula_VarRef {
  type: 'VarRef';
  varIdx: number;
}

export type Payment = Payment_ERC20;

export interface Payment_ERC20 {
  type: 'ERC20';
  token: Account;
  amountFormula: Formula;
  recipientVarIdx: number;
  estimatedDelaySeconds: bigint;
}

export type VariableRole =
  | VariableRole_PaymentRecipient
  | VariableRole_PaymentChain
  | VariableRole_Pricing
  | VariableRole_TxOutput
  | VariableRole_Witness
  | VariableRole_Query;

export interface VariableRole_PaymentRecipient {
  type: 'PaymentRecipient';
  chainId: bigint;
}

export interface VariableRole_PaymentChain {
  type: 'PaymentChain';
}

export interface VariableRole_Pricing {
  type: 'Pricing';
}

export interface VariableRole_TxOutput {
  type: 'TxOutput';
}

export interface VariableRole_Witness {
  type: 'Witness';
  kind: string;
  data: Hex;
  variables: number[];
}

export interface VariableRole_Query {
  type: 'Query';
  target: Account;
  selector: Hex; // bytes4
  arguments: Argument[];
  blockNumber: bigint;
}

export interface Assumption {
  trusted: Account;
  kind: string;
}

export type Argument = Argument_AbiWrappedValue | Argument_Variable;

export interface Argument_AbiWrappedValue {
  type: 'AbiWrappedValue';
  value: AbiWrappedValue;
}

export interface Argument_Variable {
  type: 'Variable';
  varIdx: number;
}
