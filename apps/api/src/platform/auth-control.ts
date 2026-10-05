import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { PlatformFailure } from './failure';

export const AUTH_CONTROL = Symbol('AUTH_CONTROL');
export const authSchema = `
CREATE TABLE IF NOT EXISTS auth_challenges(id TEXT PRIMARY KEY,state_hash TEXT NOT NULL,nonce_hash TEXT NOT NULL,challenge TEXT NOT NULL,intent TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(user_id),binding TEXT NOT NULL,access_hash TEXT UNIQUE NOT NULL,refresh_hash TEXT UNIQUE NOT NULL,access_expires INTEGER NOT NULL,idle_expires INTEGER NOT NULL,absolute_expires INTEGER NOT NULL,authenticated INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_spent(hash TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_limits(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_accounts(user_id TEXT PRIMARY KEY REFERENCES users(user_id),denied INTEGER NOT NULL DEFAULT 0);
`;
export interface SessionPrincipal {
  readonly userId: string;
  readonly binding: string;
  readonly sessionId: string;
  readonly authenticatedAt: number;
  readonly accessVerifier: string;
}
export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: 300;
}
export interface Challenge {
  readonly id: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly intent: 'login' | 'register';
}
export type ControlResult<T> = T | Promise<T>;
export interface AuthControl {
  limit(bucket: string, maximum: number, window: number): ControlResult<void>;
  begin(
    codeChallenge: string,
    intent: Challenge['intent'],
  ): ControlResult<Challenge>;
  consume(
    id: string,
    state: string,
    nonce: string,
    verifier: string,
  ): ControlResult<Challenge['intent']>;
  bind(userId: string, binding: string): ControlResult<void>;
  assertIdentity(userId: string, binding: string): ControlResult<void>;
  issue(
    userId: string,
    binding: string,
    authenticatedAt: number,
  ): ControlResult<SessionTokens>;
  resolve(access: string): ControlResult<SessionPrincipal>;
  assertSession(principal: SessionPrincipal): ControlResult<void>;
  refresh(refresh: string): ControlResult<SessionTokens>;
  revoke(sessionId: string): ControlResult<void>;
  revokeAll(userId: string): ControlResult<void>;
  deny(
    userId: string,
    binding: string,
    reason: 'suspension' | 'deletion',
  ): ControlResult<void>;
  deletions(): ControlResult<readonly { userId: string; binding: string }[]>;
  deleted(userId: string): ControlResult<void>;
  ready(): ControlResult<boolean>;
  close(): ControlResult<void>;
}
export function verifierHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function bindingDigest(issuer: string, subject: string): string {
  return verifierHash(
    JSON.stringify(['forja-auth-binding', 1, issuer, subject]),
  );
}
const randomToken = () => randomBytes(32).toString('base64url');
function equal(left: string, right: string): boolean {
  return (
    left.length === right.length &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}
type Row = Record<string, string | number | null>;
export class LocalAuthControl implements AuthControl {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string, authority: string, environment: string) {
    try {
      const stat = lstatSync(path);
      const parent = lstatSync(dirname(path));
      if (
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        parent.isSymbolicLink() ||
        parent.mode & 0o077
      )
        throw new Error();
      this.db = new DatabaseSync(path, { timeout: 10000 });
      this.db.exec('PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON');
      const row = this.db.prepare('SELECT * FROM authority').get();
      if (
        row?.id !== authority ||
        row.environment !== environment ||
        this.db.prepare('PRAGMA user_version').get()?.user_version !== 4
      )
        throw new Error();
      this.db.prepare('SELECT id FROM auth_sessions LIMIT 0').all();
    } catch {
      throw new PlatformFailure('unavailable');
    }
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
  private cleanup(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM auth_challenges WHERE expires <= ?').run(now);
    this.db.prepare('DELETE FROM auth_limits WHERE expires <= ?').run(now);
    this.db.prepare('DELETE FROM auth_spent WHERE expires <= ?').run(now);
    this.db
      .prepare('DELETE FROM auth_sessions WHERE absolute_expires <= ?')
      .run(now);
  }
  limit(bucket: string, maximum: number, window: number): void {
    const allowed = this.atomic(() => {
      this.cleanup();
      this.db
        .prepare(
          'INSERT INTO auth_limits VALUES (?,0,?) ON CONFLICT DO NOTHING',
        )
        .run(bucket, Date.now() + window);
      const row = this.db
        .prepare('SELECT count FROM auth_limits WHERE bucket=?')
        .get(bucket)!;
      if (Number(row.count) >= maximum) return false;
      this.db
        .prepare('UPDATE auth_limits SET count=count+1 WHERE bucket=?')
        .run(bucket);
      return true;
    });
    if (!allowed) throw new PlatformFailure('exhausted');
  }
  begin(codeChallenge: string, intent: Challenge['intent']): Challenge {
    return this.atomic(() => {
      this.cleanup();
      if (
        Number(
          this.db.prepare('SELECT count(*) AS n FROM auth_challenges').get()?.n,
        ) >= 1000
      )
        throw new PlatformFailure('exhausted');
      const value = {
        id: randomUUID(),
        state: randomToken(),
        nonce: randomToken(),
        codeChallenge,
        intent,
      };
      this.db
        .prepare('INSERT INTO auth_challenges VALUES (?,?,?,?,?,?)')
        .run(
          value.id,
          verifierHash(value.state),
          verifierHash(value.nonce),
          codeChallenge,
          intent,
          Date.now() + 300000,
        );
      return value;
    });
  }
  consume(
    id: string,
    state: string,
    nonce: string,
    verifier: string,
  ): Challenge['intent'] {
    return this.atomic(() => {
      const row = this.db
        .prepare('SELECT * FROM auth_challenges WHERE id=?')
        .get(id);
      if (
        !row ||
        Number(row.expires) <= Date.now() ||
        !equal(String(row.state_hash), verifierHash(state)) ||
        !equal(String(row.nonce_hash), verifierHash(nonce)) ||
        !equal(
          String(row.challenge),
          createHash('sha256').update(verifier).digest('base64url'),
        )
      )
        throw new PlatformFailure('fenced');
      this.db.prepare('DELETE FROM auth_challenges WHERE id=?').run(id);
      return row.intent as Challenge['intent'];
    });
  }
  bind(userId: string, binding: string): void {
    this.atomic(() => {
      this.identity(userId, binding);
      this.db
        .prepare(
          'INSERT INTO auth_accounts VALUES (?,0) ON CONFLICT DO NOTHING',
        )
        .run(userId);
      if (
        this.db
          .prepare('SELECT denied FROM auth_accounts WHERE user_id=?')
          .get(userId)?.denied
      )
        throw new PlatformFailure('fenced');
    });
  }
  private identity(userId: string, binding: string): void {
    const owner = this.db
      .prepare('SELECT * FROM users WHERE user_id=?')
      .get(userId);
    if (
      !owner ||
      !equal(String(owner.identity_digest), binding) ||
      owner.fenced ||
      owner.terminal !== null ||
      !this.db
        .prepare("SELECT 1 FROM keys WHERE user_id=? AND state='active'")
        .get(userId)
    )
      throw new PlatformFailure('fenced');
  }
  assertIdentity(userId: string, binding: string): void {
    this.atomic(() => {
      this.identity(userId, binding);
      if (
        this.db
          .prepare('SELECT denied FROM auth_accounts WHERE user_id=?')
          .get(userId)?.denied !== 0
      )
        throw new PlatformFailure('fenced');
    });
  }
  issue(
    userId: string,
    binding: string,
    authenticatedAt: number,
  ): SessionTokens {
    return this.atomic(() => {
      this.identity(userId, binding);
      if (
        this.db
          .prepare('SELECT denied FROM auth_accounts WHERE user_id=?')
          .get(userId)?.denied !== 0
      )
        throw new PlatformFailure('fenced');
      const n = Number(
        this.db
          .prepare(
            'SELECT count(*) AS n FROM auth_sessions WHERE user_id=? AND revoked=0',
          )
          .get(userId)?.n,
      );
      if (n >= 10) throw new PlatformFailure('exhausted');
      const tokens = this.tokens(),
        now = Date.now();
      this.db
        .prepare('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?,?,0)')
        .run(
          randomUUID(),
          userId,
          binding,
          verifierHash(tokens.accessToken),
          verifierHash(tokens.refreshToken),
          now + 300000,
          now + 7 * 86400000,
          now + 30 * 86400000,
          authenticatedAt,
        );
      return tokens;
    });
  }
  private tokens(): SessionTokens {
    return {
      accessToken: randomToken(),
      refreshToken: randomToken(),
      tokenType: 'Bearer',
      expiresIn: 300,
    };
  }
  private principal(row: Row): SessionPrincipal {
    this.identity(String(row.user_id), String(row.binding));
    if (
      row.revoked ||
      Number(row.absolute_expires) <= Date.now() ||
      Number(row.idle_expires) <= Date.now() ||
      this.db
        .prepare('SELECT denied FROM auth_accounts WHERE user_id=?')
        .get(String(row.user_id))?.denied !== 0
    )
      throw new PlatformFailure('fenced');
    return Object.freeze({
      userId: String(row.user_id),
      binding: String(row.binding),
      sessionId: String(row.id),
      authenticatedAt: Number(row.authenticated),
      accessVerifier: String(row.access_hash),
    });
  }
  assertSession(principal: SessionPrincipal): void {
    this.atomic(() => {
      const row = this.db
        .prepare('SELECT * FROM auth_sessions WHERE id=?')
        .get(principal.sessionId) as Row | undefined;
      if (
        !row ||
        row.user_id !== principal.userId ||
        row.binding !== principal.binding ||
        Number(row.authenticated) !== principal.authenticatedAt ||
        !equal(String(row.access_hash), principal.accessVerifier) ||
        Number(row.access_expires) <= Date.now()
      )
        throw new PlatformFailure('fenced');
      this.principal(row);
    });
  }
  resolve(access: string): SessionPrincipal {
    return this.atomic(() => {
      const hash = verifierHash(access);
      const row = this.db
        .prepare('SELECT * FROM auth_sessions WHERE access_hash=?')
        .get(hash) as Row | undefined;
      if (
        !row ||
        !equal(String(row.access_hash), hash) ||
        Number(row.access_expires) <= Date.now()
      )
        throw new PlatformFailure('fenced');
      return this.principal(row);
    });
  }
  refresh(refresh: string): SessionTokens {
    const result = this.atomic(() => {
      const now = Date.now(),
        hash = verifierHash(refresh);
      const spent = this.db
        .prepare('SELECT session_id FROM auth_spent WHERE hash=? AND expires>?')
        .get(hash, now);
      if (spent) {
        this.db
          .prepare('UPDATE auth_sessions SET revoked=1 WHERE id=?')
          .run(String(spent.session_id));
        return undefined; // Commit revocation before rejecting replay.
      }
      const row = this.db
        .prepare('SELECT * FROM auth_sessions WHERE refresh_hash=?')
        .get(hash) as Row | undefined;
      if (!row || !equal(String(row.refresh_hash), hash))
        throw new PlatformFailure('fenced');
      this.principal(row);
      const tokens = this.tokens();
      this.db
        .prepare('INSERT INTO auth_spent VALUES (?,?,?)')
        .run(hash, String(row.id), Number(row.absolute_expires));
      this.db
        .prepare(
          'UPDATE auth_sessions SET access_hash=?,refresh_hash=?,access_expires=?,idle_expires=? WHERE id=?',
        )
        .run(
          verifierHash(tokens.accessToken),
          verifierHash(tokens.refreshToken),
          now + 300000,
          Math.min(now + 7 * 86400000, Number(row.absolute_expires)),
          String(row.id),
        );
      return tokens;
    });
    if (!result) throw new PlatformFailure('fenced');
    return result;
  }
  revoke(sessionId: string): void {
    this.atomic(() => {
      this.db
        .prepare('UPDATE auth_sessions SET revoked=1 WHERE id=?')
        .run(sessionId);
    });
  }
  revokeAll(userId: string): void {
    this.atomic(() => {
      this.db
        .prepare('UPDATE auth_sessions SET revoked=1 WHERE user_id=?')
        .run(userId);
    });
  }
  deny(
    userId: string,
    binding: string,
    reason: 'suspension' | 'deletion',
  ): void {
    this.atomic(() => {
      const row = this.db
        .prepare('SELECT identity_digest FROM users WHERE user_id=?')
        .get(userId);
      if (!row || !equal(String(row.identity_digest), binding))
        throw new PlatformFailure('fenced');
      this.db
        .prepare(
          'UPDATE auth_accounts SET denied=? WHERE user_id=? AND denied<>3',
        )
        .run(reason === 'deletion' ? 2 : 1, userId);
      this.db
        .prepare('UPDATE auth_sessions SET revoked=1 WHERE user_id=?')
        .run(userId);
    });
  }
  deletions(): readonly { userId: string; binding: string }[] {
    try {
      return this.db
        .prepare(
          'SELECT a.user_id,u.identity_digest FROM auth_accounts a JOIN users u ON u.user_id=a.user_id WHERE a.denied=2 LIMIT 100',
        )
        .all()
        .map((row) => ({
          userId: String(row.user_id),
          binding: String(row.identity_digest),
        }));
    } catch {
      throw new PlatformFailure('unavailable');
    }
  }
  deleted(userId: string): void {
    this.atomic(() => {
      this.db
        .prepare(
          'UPDATE auth_accounts SET denied=3 WHERE user_id=? AND denied=2',
        )
        .run(userId);
    });
  }
  ready(): boolean {
    try {
      this.db.prepare('SELECT id FROM auth_sessions LIMIT 0').all();
      this.db.prepare('SELECT user_id FROM auth_accounts LIMIT 0').all();
      this.db.prepare('SELECT id FROM auth_challenges LIMIT 0').all();
      this.db.prepare('SELECT hash FROM auth_spent LIMIT 0').all();
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
  onApplicationShutdown(): void {
    this.close();
  }
}
