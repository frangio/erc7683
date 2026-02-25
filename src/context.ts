import type { Address, Chain, Hex, PublicClient, Transport, WalletClient as ViemWalletClient } from 'viem';
import type { Account } from './types.ts';
import type { AbiEncodedValue } from './abi-wrap.ts';

export type WalletClient = ViemWalletClient<Transport, Chain>;

export interface SolverContext {
  getPublicClient: (chainId: bigint) => PublicClient;
  getWalletClient: (chainId: bigint) => WalletClient;
  paymentChain: bigint;
  paymentRecipient: (chainId: bigint) => Address;
  fillerAddress: Address;
  isWhitelisted: (account: Account, assumption: string) => boolean;
  getWitnessResolver: (kind: string) => WitnessResolver | undefined;
  getTokenPriceUsd: (token: Account) => bigint;
  getGasPriceUsd: (chainId: bigint) => bigint;
}

interface WitnessResolver {
  resolve(data: Hex, variableValues: AbiEncodedValue[]): Promise<AbiEncodedValue>;
}
