import { createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { KeyProtectionProvider, ProtectedKey, WrapBinding } from './contracts';
import { base64, json, positive, token, wrapArray } from './encoding';
import { PlatformFailure } from '../failure';
import { LocalLifecycle } from './local-lifecycle';
export interface LocalCustody {
  readonly authorityId: string;
  readonly activeVersion: number;
  readonly keys: readonly { readonly version: number; readonly key: string }[];
}
export function readLocalCustody(path: string): LocalCustody {
  try {
    if (
      lstatSync(path).isSymbolicLink() ||
      (lstatSync(path).mode & 0o077) !== 0 ||
      lstatSync(path).size > 65536
    )
      throw new Error();
    const value = JSON.parse(readFileSync(path, 'utf8')) as LocalCustody;
    positive(value.activeVersion);
    if (
      !Array.isArray(value.keys) ||
      value.keys.length < 1 ||
      value.keys.length > 64 ||
      new Set(value.keys.map((k) => k.version)).size !== value.keys.length
    )
      throw new Error();
    for (const key of value.keys) {
      positive(key.version);
      base64(key.key, 32).fill(0);
    }
    if (!value.keys.some((key) => key.version === value.activeVersion))
      throw new Error();
    return value;
  } catch {
    throw new PlatformFailure('unavailable');
  }
}
export function localKeyRef(environment: string, version: number): string {
  return `local:${token(environment)}:user-data:${positive(version)}`;
}
export class LocalKeyProvider implements KeyProtectionProvider {
  readonly providerId = 'local-development';
  private readonly keys = new Map<number, Buffer>();
  private readonly currentVersion: number;
  constructor(
    environment: string,
    private readonly environmentId: string,
    custody: LocalCustody,
    private readonly lifecycle: LocalLifecycle,
  ) {
    if (!['development', 'test'].includes(environment))
      throw new PlatformFailure('invalid');
    token(environmentId);
    this.currentVersion = positive(custody.activeVersion);
    for (const item of custody.keys) {
      this.keys.set(item.version, base64(item.key, 32));
      if (!lifecycle.wrappingKnown(this.ref(item.version)))
        throw new PlatformFailure('unavailable');
    }
  }
  activeVersion(): number {
    return this.currentVersion;
  }
  private ref(version: number): string {
    return localKeyRef(this.environmentId, version);
  }
  async wrap(key: Buffer, binding: WrapBinding): Promise<ProtectedKey> {
    if (key.length !== 32 || binding.environment !== this.environmentId)
      throw new PlatformFailure('invalid');
    try {
      const version = this.activeVersion();
      const ref = this.ref(version);
      const wrapping = this.keys.get(version);
      if (!wrapping) throw new PlatformFailure('unavailable');
      const nonce = this.lifecycle.reserveWrapping(ref);
      const cipher = createCipheriv('aes-256-gcm', wrapping, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(json(wrapArray(binding, ref, version)));
      const bytes = Buffer.concat([cipher.update(key), cipher.final()]);
      return {
        binding,
        provider: this.providerId,
        kekRef: ref,
        kekVersion: version,
        format: 1,
        wrapped: json([
          1,
          'AES-256-GCM',
          nonce.toString('base64'),
          bytes.toString('base64'),
          cipher.getAuthTag().toString('base64'),
        ]),
      };
    } catch (error) {
      throw error instanceof PlatformFailure
        ? error
        : new PlatformFailure('unavailable');
    }
  }
  async unwrap(record: ProtectedKey, binding: WrapBinding): Promise<Buffer> {
    let pending: Buffer | undefined;
    try {
      if (
        binding.environment !== this.environmentId ||
        record.provider !== this.providerId ||
        record.format !== 1 ||
        record.kekRef !== this.ref(record.kekVersion) ||
        record.wrapped.length > 1024
      )
        throw new Error();
      const key = this.keys.get(record.kekVersion);
      if (!key) throw new Error();
      const encoded = record.wrapped.toString('utf8');
      const parts = JSON.parse(encoded) as unknown[];
      if (
        !Array.isArray(parts) ||
        parts.length !== 5 ||
        parts[0] !== 1 ||
        parts[1] !== 'AES-256-GCM' ||
        JSON.stringify(parts) !== encoded
      )
        throw new Error();
      const cipher = createDecipheriv(
        'aes-256-gcm',
        key,
        base64(parts[2], 12),
        { authTagLength: 16 },
      );
      cipher.setAAD(json(wrapArray(binding, record.kekRef, record.kekVersion)));
      cipher.setAuthTag(base64(parts[4], 16));
      pending = cipher.update(base64(parts[3], 32));
      const final = cipher.final();
      return Buffer.concat([pending, final]);
    } catch {
      throw new PlatformFailure('integrity');
    } finally {
      pending?.fill(0);
    }
  }
  async rewrap(
    record: ProtectedKey,
    binding: WrapBinding,
  ): Promise<ProtectedKey> {
    const key = await this.unwrap(record, binding);
    try {
      return await this.wrap(key, binding);
    } finally {
      key.fill(0);
    }
  }
  async ready(): Promise<boolean> {
    return (
      this.keys.has(this.activeVersion()) &&
      this.lifecycle.ready() &&
      this.lifecycle.wrappingReady(this.ref(this.activeVersion()))
    );
  }
  close(): void {
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
  }
}
