import { Crypto } from '@peculiar/webcrypto';

type RSAModulus = 2048 | 3072 | 4096;

const DEFAULT_RSA_KEY_PARAMS: RsaHashedImportParams = {
  hash: { name: 'SHA-256' },
  name: 'RSA-PSS',
};

const NODEJS_CRYPTO = new Crypto();

export async function generateRSAKeyPair(modulus: RSAModulus = 2048): Promise<CryptoKeyPair> {
  const rsaAlgorithm: RsaHashedKeyAlgorithm = {
    ...DEFAULT_RSA_KEY_PARAMS,
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
    modulusLength: modulus,
    hash: { name: 'SHA-256' },
  };
  return NODEJS_CRYPTO.subtle.generateKey(rsaAlgorithm, true, ['sign', 'verify']);
}

export async function derSerializePublicKey(publicKey: CryptoKey): Promise<Buffer> {
  const publicKeyDer = await NODEJS_CRYPTO.subtle.exportKey('spki', publicKey);
  return Buffer.from(publicKeyDer);
}
