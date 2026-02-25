import type { AbiType, AbiTypeToPrimitiveType } from 'abitype';
import { concat, encodeAbiParameters, hexToNumber, size, slice, type Hex } from 'viem';

export interface AbiEncodedValue {
  type: 'Static' | 'Dynamic';
  encoding: Hex;
}

export function abiEncode<const T extends AbiType>(value: AbiTypeToPrimitiveType<T>, type: T): AbiEncodedValue {
  return decodeAbiWrappedValue(
    // @ts-ignore
    encodeAbiParameters([{ type: 'string' }, { type }], ["", value])
  );
}

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

const DYN_PREFIX = concat([
  '0x0000000000000000000000000000000000000000000000000000000000000040',
  '0x0000000000000000000000000000000000000000000000000000000000000060',
  '0x0000000000000000000000000000000000000000000000000000000000000000',
]);

export function decodeAbiWrappedValue(encoded: Hex): AbiEncodedValue {
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
