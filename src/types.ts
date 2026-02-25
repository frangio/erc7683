import type { Address, Hex } from 'viem';
import type { AbiEncodedValue } from './abi-wrap.ts';

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
  attributes: Attributes;
  payments: Payment[];
}

export interface Attributes {
  SpendsERC20: Attribute_SpendsERC20[];
  SpendsEstimatedGas?: Attribute_SpendsEstimatedGas;

  RevertPolicy: Attribute_RevertPolicy[];

  RequiredBefore?: Attribute_RequiredBefore;
  RequiredFillerUntil?: Attribute_RequiredFillerUntil;
  RequiredCallResult?: Attribute_RequiredCallResult;

  WithTimestamp?: Attribute_WithTimestamp;
  WithBlockNumber?: Attribute_WithBlockNumber;
  WithEffectiveGasPrice?: Attribute_WithEffectiveGasPrice;
}

export type Attribute =
  | Attribute_SpendsERC20
  | Attribute_SpendsEstimatedGas
  | Attribute_RevertPolicy
  | Attribute_RequiredBefore
  | Attribute_RequiredFillerUntil
  | Attribute_RequiredCallResult
  | Attribute_WithTimestamp
  | Attribute_WithBlockNumber
  | Attribute_WithEffectiveGasPrice;

export interface Attribute_SpendsERC20 {
  type: 'SpendsERC20';
  token: Account;
  amountFormula: Formula;
  spender: Account;
  receiver: Account;
}

export interface Attribute_SpendsEstimatedGas {
  type: 'SpendsEstimatedGas';
  amountFormula: Formula;
}

export interface Attribute_RevertPolicy {
  type: 'RevertPolicy';
  policy: 'drop' | 'ignore'; // TODO: 'retry';
  expectedReason: Hex;
}

export interface Attribute_RequiredBefore {
  type: 'RequiredBefore';
  deadline: bigint;
}

export interface Attribute_RequiredFillerUntil {
  type: 'RequiredFillerUntil';
  exclusiveFiller: Address;
  deadline: bigint;
}

export interface Attribute_RequiredCallResult {
  type: 'RequiredCallResult';
  target: Account;
  selector: Hex; // bytes4
  arguments: Argument[];
  result: Hex;
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

export type Formula = Formula_Constant | Formula_Variable;

export interface Formula_Constant {
  type: 'Constant';
  value: bigint;
}

export interface Formula_Variable {
  type: 'Variable';
  varIdx: number;
}

export type Payment = Payment_ERC20;

export interface Payment_ERC20 {
  type: 'ERC20';
  token: Account;
  sender: Account;
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
  | VariableRole_Query
  | VariableRole_QueryEvents;

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

export interface VariableRole_QueryEvents {
  type: 'QueryEvents';
  emitter: Account;
  topicMatch: Hex;
  topic0: Hex;
  topic1: Hex;
  topic2: Hex;
  topic3: Hex;
}

export interface Assumption {
  trusted: Account;
  kind: string;
}

export type Argument = Argument_Variable | Argument_AbiEncodedValue;

export interface Argument_Variable {
  type: 'Variable';
  varIdx: number;
}

export interface Argument_AbiEncodedValue {
  type: 'AbiEncodedValue';
  value: AbiEncodedValue;
}
