import type { Address, Hex, PublicClient } from 'viem';
import type { Account } from './types.ts';
import type { AbiWrappedValue } from './abi-wrap.ts';

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

interface WitnessResolver {
  resolve(data: Hex, variableValues: AbiWrappedValue[]): Promise<AbiWrappedValue>;
}
