import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Admission,
  KeyIdentity,
  KeyLifecycleStore,
  KeyState,
} from './contracts';
import { digest, positive, token, uuid } from './encoding';
import { PlatformFailure } from '../failure';
import { authSchema } from '../auth-control';
type Row = Record<string, string | number | null>;
const year = 365 * 86400000;
const hardCap = 2 ** 32;
export class LocalLifecycle implements KeyLifecycleStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly writer = randomUUID();
  constructor(
    path: string,
    authorityId: string,
    environment: string,
    initialize = false,
  ) {
    try {
      uuid(authorityId);
      token(environment);
      if (
        lstatSync(dirname(path)).isSymbolicLink() ||
        (lstatSync(dirname(path)).mode & 0o077) !== 0
      )
        throw new Error();
      if (!initialize && !existsSync(path)) throw new Error();
      if (
        existsSync(path) &&
        (lstatSync(path).isSymbolicLink() ||
          (lstatSync(path).mode & 0o077) !== 0)
      )
        throw new Error();
      this.db = new DatabaseSync(path, { timeout: 10000 });
      chmodSync(path, 0o600);
      this.db.exec('PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON;');
      if (initialize) {
        const priorVersion = Number(
          this.db.prepare('PRAGMA user_version').get()?.user_version,
        );
        if (![0, 1, 2, 3, 4].includes(priorVersion)) throw new Error();
        this.atomic(() => {
          if (
            priorVersion === 1 &&
            !this.db
              .prepare('PRAGMA table_info(users)')
              .all()
              .some((row) => row.name === 'fence_reason')
          )
            this.db.exec('ALTER TABLE users ADD COLUMN fence_reason TEXT');
          this.db
            .exec(`CREATE TABLE IF NOT EXISTS authority (id TEXT PRIMARY KEY, environment TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, identity_digest TEXT NOT NULL, fenced INTEGER NOT NULL DEFAULT 0, terminal TEXT, fence_reason TEXT);
            CREATE TABLE IF NOT EXISTS keys (dek_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), version INTEGER NOT NULL, state TEXT NOT NULL, fingerprint TEXT, count INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, UNIQUE(user_id,version));
            CREATE UNIQUE INDEX IF NOT EXISTS one_active ON keys(user_id) WHERE state='active';
            CREATE TABLE IF NOT EXISTS admissions (lease_id TEXT PRIMARY KEY, writer TEXT NOT NULL, dek_id TEXT NOT NULL REFERENCES keys(dek_id), mode TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS wrap_intents (dek_id TEXT PRIMARY KEY, previous TEXT NOT NULL, next TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS wrapping (scope TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, key_id TEXT, event TEXT NOT NULL, created INTEGER NOT NULL);
            ${authSchema}
            CREATE TABLE IF NOT EXISTS financial_anchors (user_id TEXT NOT NULL, seq INTEGER NOT NULL, digest TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(user_id,seq));
            PRAGMA user_version=4;`);
          if (!this.db.prepare('SELECT id FROM authority').get())
            this.db
              .prepare('INSERT INTO authority VALUES (?,?)')
              .run(authorityId, environment);
        });
      }
      const authority = this.db
        .prepare('SELECT id,environment FROM authority')
        .get();
      if (
        authority?.id !== authorityId ||
        authority.environment !== environment ||
        this.db.prepare('PRAGMA user_version').get()?.user_version !== 4
      )
        throw new Error();
    } catch {
      throw new PlatformFailure('unavailable');
    }
  }
  anchorHead(userId: string): { seq: number; digest: string } | undefined {
    uuid(userId);
    try {
      const row = this.db
        .prepare(
          'SELECT seq,digest FROM financial_anchors WHERE user_id=? ORDER BY seq DESC LIMIT 1',
        )
        .get(userId);
      return row
        ? { seq: Number(row.seq), digest: String(row.digest) }
        : undefined;
    } catch {
      throw new PlatformFailure('unavailable');
    }
  }
  anchor(userId: string, seq: number, envelopeDigest: string): void {
    uuid(userId);
    positive(seq);
    digest(envelopeDigest);
    this.atomic(() => {
      const user = this.db
        .prepare('SELECT terminal,fenced FROM users WHERE user_id=?')
        .get(userId);
      if (!user || user.terminal !== null || user.fenced !== 0)
        throw new PlatformFailure('fenced');
      const existing = this.db
        .prepare(
          'SELECT digest FROM financial_anchors WHERE user_id=? AND seq=?',
        )
        .get(userId, seq);
      if (existing && existing.digest !== envelopeDigest)
        throw new PlatformFailure('integrity');
      this.db
        .prepare('INSERT OR IGNORE INTO financial_anchors VALUES (?,?,?,?)')
        .run(userId, seq, envelopeDigest, Date.now());
    });
  }
  private atomic<T>(operation: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      throw error instanceof PlatformFailure
        ? error
        : new PlatformFailure('unavailable');
    }
  }
  private key(identity: KeyIdentity): Row {
    uuid(identity.userId);
    uuid(identity.dekId);
    positive(identity.version);
    const row = this.db
      .prepare('SELECT * FROM keys WHERE dek_id=? AND user_id=? AND version=?')
      .get(identity.dekId, identity.userId, identity.version) as
      Row | undefined;
    if (!row) throw new PlatformFailure('fenced');
    return row;
  }
  private journal(user: string, key: string | null, event: string): void {
    this.db
      .prepare(
        'INSERT INTO journal(user_id,key_id,event,created) VALUES (?,?,?,?)',
      )
      .run(user, key, event, Date.now());
  }
  createPending(userId: string, identityDigest: string): KeyIdentity {
    uuid(userId);
    digest(identityDigest);
    return this.atomic(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO users(user_id,identity_digest) VALUES (?,?)',
        )
        .run(userId, identityDigest);
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(userId);
      if (owner?.identity_digest !== identityDigest || owner.terminal !== null)
        throw new PlatformFailure('fenced');
      const prior = this.db
        .prepare('SELECT max(version) AS version FROM keys WHERE user_id=?')
        .get(userId);
      const version = Number(prior?.version ?? 0) + 1;
      positive(version);
      const key = { userId, dekId: randomUUID(), version };
      this.db
        .prepare(
          "INSERT INTO keys(dek_id,user_id,version,state,created) VALUES (?,?,?,'pending',?)",
        )
        .run(key.dekId, userId, version, Date.now());
      this.journal(userId, key.dekId, 'pending');
      return key;
    });
  }
  enroll(key: KeyIdentity, fingerprint: string): void {
    digest(fingerprint);
    this.atomic(() => {
      const row = this.key(key);
      if (
        row.state !== 'pending' ||
        (row.fingerprint !== null && row.fingerprint !== fingerprint)
      )
        throw new PlatformFailure('conflict');
      this.db
        .prepare('UPDATE keys SET fingerprint=? WHERE dek_id=?')
        .run(fingerprint, key.dekId);
      this.journal(key.userId, key.dekId, 'enrolled');
    });
  }
  activate(key: KeyIdentity, fingerprint: string): void {
    digest(fingerprint);
    this.atomic(() => {
      const row = this.key(key);
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(key.userId);
      if (
        row.state !== 'pending' ||
        row.fingerprint !== fingerprint ||
        owner?.terminal !== null
      )
        throw new PlatformFailure('fenced');
      const prior = this.db
        .prepare("SELECT dek_id FROM keys WHERE user_id=? AND state='active'")
        .get(key.userId);
      if (prior && !owner.fenced) throw new PlatformFailure('fenced');
      if (
        this.db
          .prepare(
            'SELECT 1 FROM admissions a JOIN keys k ON k.dek_id=a.dek_id WHERE k.user_id=?',
          )
          .get(key.userId)
      )
        throw new PlatformFailure('fenced');
      this.db
        .prepare(
          "UPDATE keys SET state='decrypt-only' WHERE user_id=? AND state='active'",
        )
        .run(key.userId);
      this.db
        .prepare("UPDATE keys SET state='active' WHERE dek_id=?")
        .run(key.dekId);
      this.db
        .prepare('UPDATE users SET fenced=0,fence_reason=NULL WHERE user_id=?')
        .run(key.userId);
      this.journal(key.userId, key.dekId, 'active');
    });
  }
  active(userId: string): KeyIdentity {
    uuid(userId);
    try {
      const row = this.db
        .prepare(
          "SELECT k.* FROM keys k JOIN users u USING(user_id) WHERE k.user_id=? AND k.state='active' AND u.fenced=0 AND u.terminal IS NULL",
        )
        .get(userId);
      if (!row) throw new PlatformFailure('fenced');
      return {
        userId,
        dekId: String(row.dek_id),
        version: Number(row.version),
      };
    } catch (error) {
      throw error instanceof PlatformFailure
        ? error
        : new PlatformFailure('unavailable');
    }
  }
  admit(
    key: KeyIdentity,
    identityDigest: string,
    fingerprint: string,
    mode: Admission['mode'],
  ): Admission {
    digest(identityDigest);
    digest(fingerprint);
    if (!['encrypt', 'decrypt'].includes(mode))
      throw new PlatformFailure('invalid');
    return this.atomic(() => {
      const row = this.key(key);
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(key.userId);
      if (
        owner?.identity_digest !== identityDigest ||
        owner.fenced ||
        owner.terminal !== null ||
        row.fingerprint !== fingerprint ||
        !(
          row.state === 'active' ||
          (mode === 'decrypt' && row.state === 'decrypt-only')
        )
      )
        throw new PlatformFailure('fenced');
      const lease = { ...key, leaseId: randomUUID(), mode };
      this.db
        .prepare('INSERT INTO admissions VALUES (?,?,?,?)')
        .run(lease.leaseId, this.writer, key.dekId, mode);
      return lease;
    });
  }
  assertAdmission(lease: Admission): void {
    try {
      this.key(lease);
      if (
        !this.db
          .prepare(
            'SELECT 1 FROM admissions WHERE lease_id=? AND writer=? AND dek_id=? AND mode=?',
          )
          .get(lease.leaseId, this.writer, lease.dekId, lease.mode)
      )
        throw new PlatformFailure('fenced');
    } catch (error) {
      throw error instanceof PlatformFailure
        ? error
        : new PlatformFailure('unavailable');
    }
  }
  release(lease: Admission): void {
    this.atomic(() => {
      this.assertAdmission(lease);
      this.db
        .prepare('DELETE FROM admissions WHERE lease_id=?')
        .run(lease.leaseId);
    });
  }
  private allocation(count: number, created: number): Buffer {
    if (count >= 2 ** 31 || count >= hardCap || Date.now() - created >= year)
      throw new PlatformFailure('exhausted');
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(count + 1), 4);
    return nonce;
  }
  reserve(lease: Admission): Buffer {
    return this.atomic(() => {
      this.assertAdmission(lease);
      if (lease.mode !== 'encrypt') throw new PlatformFailure('fenced');
      const key = this.key(lease);
      const nonce = this.allocation(Number(key.count), Number(key.created));
      this.db
        .prepare('UPDATE keys SET count=count+1 WHERE dek_id=?')
        .run(lease.dekId);
      return nonce;
    });
  }
  registerWrapping(scope: string): void {
    token(scope);
    this.atomic(() =>
      this.db
        .prepare('INSERT OR IGNORE INTO wrapping(scope,created) VALUES (?,?)')
        .run(scope, Date.now()),
    );
  }
  wrappingKnown(scope: string): boolean {
    try {
      return !!this.db
        .prepare('SELECT 1 FROM wrapping WHERE scope=?')
        .get(token(scope));
    } catch {
      return false;
    }
  }
  wrappingReady(scope: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT count,created FROM wrapping WHERE scope=?')
        .get(token(scope));
      return (
        !!row &&
        Number(row.count) < 2 ** 31 &&
        Date.now() - Number(row.created) < year
      );
    } catch {
      return false;
    }
  }
  reserveWrapping(scope: string): Buffer {
    token(scope);
    return this.atomic(() => {
      const row = this.db
        .prepare('SELECT * FROM wrapping WHERE scope=?')
        .get(scope);
      if (!row) throw new PlatformFailure('fenced');
      const nonce = this.allocation(Number(row.count), Number(row.created));
      this.db
        .prepare('UPDATE wrapping SET count=count+1 WHERE scope=?')
        .run(scope);
      return nonce;
    });
  }
  rotationDue(key: KeyIdentity): boolean {
    const row = this.key(key);
    return (
      Number(row.count) >= 2 ** 31 || Date.now() - Number(row.created) >= year
    );
  }
  fence(userId: string, reason: 'transition' | 'rewrap' = 'transition'): void {
    uuid(userId);
    this.atomic(() => {
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(userId);
      if (owner?.fenced && owner.fence_reason !== reason)
        throw new PlatformFailure('conflict');
      if (!owner) throw new PlatformFailure('fenced');
      this.db
        .prepare('UPDATE users SET fenced=1,fence_reason=? WHERE user_id=?')
        .run(reason, userId);
      this.journal(userId, null, 'fenced');
    });
  }
  transition(userId: string, state: 'revoked' | 'deleted'): void {
    uuid(userId);
    if (!['revoked', 'deleted'].includes(state))
      throw new PlatformFailure('invalid');
    this.atomic(() => {
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(userId);
      if (
        !owner?.fenced ||
        (owner.terminal === 'deleted' && state !== 'deleted') ||
        this.db
          .prepare(
            'SELECT 1 FROM admissions a JOIN keys k ON k.dek_id=a.dek_id WHERE k.user_id=?',
          )
          .get(userId)
      )
        throw new PlatformFailure('fenced');
      this.db
        .prepare('UPDATE keys SET state=? WHERE user_id=?')
        .run(state, userId);
      this.db
        .prepare('UPDATE users SET terminal=? WHERE user_id=?')
        .run(state, userId);
      this.journal(userId, null, state);
    });
  }
  replaceWrapping(key: KeyIdentity, previous: string, next: string): void {
    digest(previous);
    digest(next);
    this.atomic(() => {
      const row = this.key(key);
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(key.userId);
      if (
        (row.fingerprint !== previous && row.fingerprint !== next) ||
        !owner?.fenced ||
        owner.terminal !== null ||
        this.db
          .prepare(
            'SELECT 1 FROM admissions a JOIN keys k ON k.dek_id=a.dek_id WHERE k.user_id=?',
          )
          .get(key.userId)
      )
        throw new PlatformFailure('fenced');
      this.db
        .prepare('UPDATE keys SET fingerprint=? WHERE dek_id=?')
        .run(next, key.dekId);
      this.journal(key.userId, key.dekId, 'rewrapped');
    });
  }
  admitMaintenance(
    key: KeyIdentity,
    identityDigest: string,
    fingerprint: string,
  ): Admission {
    digest(identityDigest);
    digest(fingerprint);
    return this.atomic(() => {
      const row = this.key(key);
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(key.userId);
      if (
        owner?.identity_digest !== identityDigest ||
        owner.terminal !== null ||
        row.fingerprint !== fingerprint ||
        !['pending', 'active', 'decrypt-only'].includes(String(row.state))
      )
        throw new PlatformFailure('fenced');
      if (row.state !== 'pending') this.assertMaintenance(key, fingerprint);
      const lease: Admission = {
        ...key,
        leaseId: randomUUID(),
        mode: 'maintenance',
      };
      this.db
        .prepare('INSERT INTO admissions VALUES (?,?,?,?)')
        .run(lease.leaseId, this.writer, key.dekId, lease.mode);
      return lease;
    });
  }
  assertMaintenance(key: KeyIdentity, expectedFingerprint?: string): void {
    const row = this.key(key);
    const owner = this.db
      .prepare('SELECT * FROM users WHERE user_id=?')
      .get(key.userId);
    if (
      owner?.terminal !== null ||
      (expectedFingerprint === undefined
        ? row.state !== 'pending'
        : row.fingerprint !== expectedFingerprint || !owner.fenced) ||
      this.db
        .prepare(
          'SELECT 1 FROM admissions a JOIN keys k ON k.dek_id=a.dek_id WHERE k.user_id=?',
        )
        .get(key.userId)
    )
      throw new PlatformFailure('fenced');
  }
  stageWrapping(key: KeyIdentity, previous: string, next: string): void {
    digest(previous);
    digest(next);
    this.atomic(() => {
      const row = this.key(key);
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(key.userId);
      if (
        row.fingerprint !== previous ||
        !owner?.fenced ||
        owner.fence_reason !== 'rewrap' ||
        owner.terminal !== null ||
        this.db
          .prepare(
            'SELECT 1 FROM admissions a JOIN keys k ON k.dek_id=a.dek_id WHERE k.user_id=?',
          )
          .get(key.userId)
      )
        throw new PlatformFailure('fenced');
      this.db
        .prepare('INSERT INTO wrap_intents VALUES (?,?,?)')
        .run(key.dekId, previous, next);
      this.journal(key.userId, key.dekId, 'rewrap-staged');
    });
  }
  wrappingIntent(
    key: KeyIdentity,
  ): { previous: string; next: string } | undefined {
    this.key(key);
    const row = this.db
      .prepare('SELECT previous,next FROM wrap_intents WHERE dek_id=?')
      .get(key.dekId);
    return row
      ? { previous: String(row.previous), next: String(row.next) }
      : undefined;
  }
  finishWrapping(key: KeyIdentity, persistedFingerprint: string): void {
    digest(persistedFingerprint);
    this.atomic(() => {
      const intent = this.wrappingIntent(key);
      const row = this.key(key);
      const owner = this.db
        .prepare('SELECT * FROM users WHERE user_id=?')
        .get(key.userId);
      if (
        !intent ||
        owner?.terminal !== null ||
        !owner.fenced ||
        owner.fence_reason !== 'rewrap' ||
        row.fingerprint !== persistedFingerprint ||
        (persistedFingerprint !== intent.previous &&
          persistedFingerprint !== intent.next) ||
        this.db
          .prepare(
            'SELECT 1 FROM admissions a JOIN keys k ON k.dek_id=a.dek_id WHERE k.user_id=?',
          )
          .get(key.userId)
      )
        throw new PlatformFailure('fenced');
      this.db.prepare('DELETE FROM wrap_intents WHERE dek_id=?').run(key.dekId);
      this.db
        .prepare('UPDATE users SET fenced=0,fence_reason=NULL WHERE user_id=?')
        .run(key.userId);
      this.journal(key.userId, key.dekId, 'rewrap-completed');
    });
  }
  state(key: KeyIdentity): KeyState {
    return this.key(key).state as KeyState;
  }
  ready(): boolean {
    try {
      this.db.prepare('SELECT seq,digest FROM financial_anchors LIMIT 0').all();
      return this.db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok';
    } catch {
      return false;
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
