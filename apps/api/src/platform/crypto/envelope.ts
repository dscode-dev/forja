import { createCipheriv, createDecipheriv } from 'node:crypto';
import { PlatformFailure } from '../failure';
import { base64, json, positive, token, uuid } from './encoding';
export interface PayloadContext {
  readonly environment: string;
  readonly userId: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly slot: string;
  readonly revision: number;
  readonly metadataSchema: number;
  readonly metadata: readonly (string | number | boolean | null)[];
  readonly dekId: string;
  readonly dekVersion: number;
  readonly payloadSchema: number;
}
export interface Envelope {
  readonly format: 1;
  readonly algorithm: 'AES-256-GCM';
  readonly dek_id: string;
  readonly dek_version: number;
  readonly payload_schema: number;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}
const limit = 1048576;
export function aad(context: PayloadContext): Buffer {
  if (
    !Array.isArray(context.metadata) ||
    context.metadata.length > 64 ||
    context.metadata.some(
      (value) =>
        !(
          value === null ||
          typeof value === 'boolean' ||
          (typeof value === 'string' &&
            value.length <= 512 &&
            !/[\uD800-\uDFFF]/u.test(value)) ||
          (typeof value === 'number' && Number.isSafeInteger(value))
        ),
    )
  )
    throw new PlatformFailure('invalid');
  return json([
    'forja',
    1,
    token(context.environment),
    uuid(context.userId),
    token(context.entityKind),
    uuid(context.entityId),
    token(context.slot),
    positive(context.revision),
    positive(context.metadataSchema),
    context.metadata,
    uuid(context.dekId),
    positive(context.dekVersion),
    positive(context.payloadSchema),
    'AES-256-GCM',
  ]);
}
// This parser accepts the canonical serializer's representation only. JSON.parse alone silently accepts duplicate keys.
export function parseEnvelope(serialized: string): Envelope {
  try {
    if (Buffer.byteLength(serialized) > 1400500)
      throw new PlatformFailure('invalid');
    const value = JSON.parse(serialized) as Envelope;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      JSON.stringify(value) !== serialized ||
      Object.keys(value).join(',') !==
        'format,algorithm,dek_id,dek_version,payload_schema,nonce,ciphertext,tag'
    )
      throw new PlatformFailure('invalid');
    if (value.format !== 1 || value.algorithm !== 'AES-256-GCM')
      throw new PlatformFailure('invalid');
    uuid(value.dek_id);
    positive(value.dek_version);
    positive(value.payload_schema);
    base64(value.nonce, 12);
    base64(value.tag, 16);
    if (base64(value.ciphertext).length > limit)
      throw new PlatformFailure('invalid');
    return Object.freeze(value);
  } catch {
    throw new PlatformFailure('invalid');
  }
}
export function seal(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  context: PayloadContext,
): string {
  if (key.length !== 32 || nonce.length !== 12 || plaintext.length > limit)
    throw new PlatformFailure('invalid');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return JSON.stringify({
      format: 1,
      algorithm: 'AES-256-GCM',
      dek_id: context.dekId,
      dek_version: context.dekVersion,
      payload_schema: context.payloadSchema,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    } satisfies Envelope);
  } catch {
    throw new PlatformFailure('invalid');
  }
}
export function open(
  key: Buffer,
  serialized: string,
  context: PayloadContext,
): Buffer {
  const envelope = parseEnvelope(serialized);
  if (
    key.length !== 32 ||
    envelope.dek_id !== context.dekId ||
    envelope.dek_version !== context.dekVersion ||
    envelope.payload_schema !== context.payloadSchema
  )
    throw new PlatformFailure('integrity');
  let pending: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      base64(envelope.nonce, 12),
      { authTagLength: 16 },
    );
    decipher.setAAD(aad(context));
    decipher.setAuthTag(base64(envelope.tag, 16));
    pending = decipher.update(base64(envelope.ciphertext));
    const final = decipher.final();
    return Buffer.concat([pending, final]);
  } catch {
    throw new PlatformFailure('integrity');
  } finally {
    pending?.fill(0);
  }
}
