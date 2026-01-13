import { parseAbi } from 'viem';

export const resolverAbi = parseAbi([
  'function resolve(bytes payload) view returns (ResolvedOrder)',
  'struct ResolvedOrder { bytes[] steps; bytes[] variables; Assumption[] assumptions; bytes[] payments; }',
  'struct Assumption { bytes trusted; string kind; }',
]);

export const stepAbi = parseAbi([
  'function Call(bytes target, bytes4 selector, bytes[] arguments, bytes[] attributes, uint256[] dependencySteps, bytes[] payments) external',
]);

export const attributeAbi = parseAbi([
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

export const formulaAbi = parseAbi([
  'function Const(uint256 val) external',
  'function VarRef(uint256 varIdx) external',
]);

export const paymentAbi = parseAbi([
  'function ERC20(bytes token, bytes amountFormula, uint256 recipientVarIdx, uint256 estimatedDelaySeconds) external',
]);

export const variableRoleAbi = parseAbi([
  'function PaymentRecipient(uint256 chainId) external',
  'function PaymentChain() external',
  'function Pricing() external',
  'function TxOutput() external',
  'function Witness(string kind, bytes data, uint256[] variables) external',
  'function Query(bytes target, bytes4 selector, bytes[] arguments, uint256 blockNumber) external',
]);
