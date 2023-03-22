import { KeyManagementServiceClient } from '@google-cloud/kms';
import { calculate as calculateCRC32C } from 'fast-crc32c';
import { CryptoKey, RsaPssProvider } from 'webcrypto-core';

import { bufferToArrayBuffer } from '../utils/buffer';
import { KmsError } from '../KmsError';
import { GcpKmsRsaPssPrivateKey } from './GcpKmsRsaPssPrivateKey';
import { KMS_REQUEST_OPTIONS, wrapGCPCallError } from './kmsUtils';
import { sleep } from '../utils/timing';

// See: https://cloud.google.com/kms/docs/algorithms#rsa_signing_algorithms
const SUPPORTED_SALT_LENGTHS: readonly number[] = [
  256 / 8, // SHA-256
  512 / 8, // SHA-512
];

export class GcpKmsRsaPssProvider extends RsaPssProvider {
  constructor(public kmsClient: KeyManagementServiceClient) {
    super();

    // See: https://cloud.google.com/kms/docs/algorithms#rsa_signing_algorithms
    this.hashAlgorithms = ['SHA-256', 'SHA-512'];
  }

  public async onGenerateKey(): Promise<CryptoKeyPair> {
    throw new KmsError('Key generation is unsupported');
  }

  public async onImportKey(): Promise<CryptoKey> {
    throw new KmsError('Key import is unsupported');
  }

  public async onExportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer> {
    if (format !== 'spki') {
      throw new KmsError('Private key cannot be exported');
    }
    if (!(key instanceof GcpKmsRsaPssPrivateKey)) {
      throw new KmsError('Key is not managed by KMS');
    }
    return retrieveKMSPublicKey(key.kmsKeyVersionPath, this.kmsClient);
  }

  public async onSign(
    algorithm: RsaPssParams,
    key: CryptoKey,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (!(key instanceof GcpKmsRsaPssPrivateKey)) {
      throw new KmsError(`Cannot sign with key of unsupported type (${key.constructor.name})`);
    }

    if (!SUPPORTED_SALT_LENGTHS.includes(algorithm.saltLength)) {
      throw new KmsError(`Unsupported salt length of ${algorithm.saltLength} octets`);
    }

    return this.kmsSign(Buffer.from(data), key);
  }

  public async onVerify(): Promise<boolean> {
    throw new KmsError('Signature verification is unsupported');
  }

  private async kmsSign(plaintext: Buffer, key: GcpKmsRsaPssPrivateKey): Promise<ArrayBuffer> {
    const plaintextChecksum = calculateCRC32C(plaintext);
    const [response] = await wrapGCPCallError(
      this.kmsClient.asymmetricSign(
        { data: plaintext, dataCrc32c: { value: plaintextChecksum }, name: key.kmsKeyVersionPath },
        KMS_REQUEST_OPTIONS,
      ),
      'KMS signature request failed',
    );

    if (response.name !== key.kmsKeyVersionPath) {
      throw new KmsError(`KMS used the wrong key version (${response.name})`);
    }
    if (!response.verifiedDataCrc32c) {
      throw new KmsError('KMS failed to verify plaintext CRC32C checksum');
    }
    const signature = response.signature as Buffer;
    if (calculateCRC32C(signature) !== Number(response.signatureCrc32c!.value)) {
      throw new KmsError('Signature CRC32C checksum does not match one received from KMS');
    }
    return bufferToArrayBuffer(signature);
  }
}

export async function retrieveKMSPublicKey(
  kmsKeyVersionName: string,
  kmsClient: KeyManagementServiceClient,
): Promise<ArrayBuffer> {
  const retrieveWhenReady = async () => {
    let key: string;
    try {
      key = await _retrieveKMSPublicKey(kmsKeyVersionName, kmsClient);
    } catch (err) {
      if (!isKeyPendingCreation(err as Error)) {
        throw err;
      }

      // Let's give KMS a bit more time to generate the key
      await sleep(500);
      key = await _retrieveKMSPublicKey(kmsKeyVersionName, kmsClient);
    }
    return key;
  };
  const publicKeyPEM = await wrapGCPCallError(retrieveWhenReady(), 'Failed to retrieve public key');
  const publicKeyDer = pemToDer(publicKeyPEM);
  return bufferToArrayBuffer(publicKeyDer);
}

async function _retrieveKMSPublicKey(
  kmsKeyVersionName: string,
  kmsClient: KeyManagementServiceClient,
): Promise<string> {
  const [response] = await kmsClient.getPublicKey(
    { name: kmsKeyVersionName },
    {
      maxRetries: 3,
      timeout: 300,
    },
  );
  return response.pem!;
}

function isKeyPendingCreation(err: Error): boolean {
  const statusDetails = (err as any).statusDetails ?? [];
  const pendingCreationViolations = statusDetails.filter(
    (d: any) => 0 < d.violations.filter((v: any) => v.type === 'KEY_PENDING_GENERATION').length,
  );
  return !!pendingCreationViolations.length;
}

function pemToDer(pemBuffer: string): Buffer {
  const oneliner = pemBuffer.toString().replace(/(-----[\w ]*-----|\n)/g, '');
  return Buffer.from(oneliner, 'base64');
}
