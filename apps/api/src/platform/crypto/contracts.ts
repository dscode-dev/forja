export interface WrapBinding {
  readonly environment: string;
  readonly userId: string;
  readonly dekId: string;
  readonly version: number;
}
export interface ProtectedKey {
  readonly binding: WrapBinding;
  readonly provider: string;
  readonly kekRef: string;
  readonly kekVersion: number;
  readonly format: 1;
  readonly wrapped: Buffer;
}
export interface KeyProtectionProvider {
  readonly providerId: string;
  activeVersion(): number;
  wrap(key: Buffer, binding: WrapBinding): Promise<ProtectedKey>;
  unwrap(record: ProtectedKey, binding: WrapBinding): Promise<Buffer>;
  rewrap(record: ProtectedKey, binding: WrapBinding): Promise<ProtectedKey>;
  ready(): Promise<boolean>;
  close(): void;
}
export type KeyState =
  'pending' | 'active' | 'decrypt-only' | 'retired' | 'revoked' | 'deleted';
export interface KeyIdentity {
  readonly userId: string;
  readonly dekId: string;
  readonly version: number;
}
export interface Admission extends KeyIdentity {
  readonly leaseId: string;
  readonly mode: 'encrypt' | 'decrypt' | 'maintenance';
}
export type LifecycleResult<T> = T | Promise<T>;
export interface FinancialAnchor {
  readonly seq: number;
  readonly digest: string;
}
export interface KeyLifecycleStore {
  anchorHead(userId: string): LifecycleResult<FinancialAnchor | undefined>;
  anchor(
    userId: string,
    seq: number,
    envelopeDigest: string,
  ): LifecycleResult<void>;
  createPending(
    userId: string,
    identityDigest: string,
  ): LifecycleResult<KeyIdentity>;
  enroll(key: KeyIdentity, fingerprint: string): LifecycleResult<void>;
  activate(key: KeyIdentity, fingerprint: string): LifecycleResult<void>;
  active(userId: string): LifecycleResult<KeyIdentity>;
  admit(
    key: KeyIdentity,
    identityDigest: string,
    fingerprint: string,
    mode: Admission['mode'],
  ): LifecycleResult<Admission>;
  assertAdmission(lease: Admission): LifecycleResult<void>;
  release(lease: Admission): LifecycleResult<void>;
  reserve(lease: Admission): LifecycleResult<Buffer>;
  fence(
    userId: string,
    reason?: 'transition' | 'rewrap',
  ): LifecycleResult<void>;
  transition(
    userId: string,
    state: 'revoked' | 'deleted',
  ): LifecycleResult<void>;
  replaceWrapping(
    key: KeyIdentity,
    previous: string,
    next: string,
  ): LifecycleResult<void>;
  admitMaintenance(
    key: KeyIdentity,
    identityDigest: string,
    fingerprint: string,
  ): LifecycleResult<Admission>;
  assertMaintenance(
    key: KeyIdentity,
    expectedFingerprint?: string,
  ): LifecycleResult<void>;
  stageWrapping(
    key: KeyIdentity,
    previous: string,
    next: string,
  ): LifecycleResult<void>;
  wrappingIntent(
    key: KeyIdentity,
  ): LifecycleResult<{ previous: string; next: string } | undefined>;
  finishWrapping(
    key: KeyIdentity,
    persistedFingerprint: string,
  ): LifecycleResult<void>;
  state(key: KeyIdentity): LifecycleResult<KeyState>;
  rotationDue(key: KeyIdentity): LifecycleResult<boolean>;
  ready(): LifecycleResult<boolean>;
  close(): LifecycleResult<void>;
}
