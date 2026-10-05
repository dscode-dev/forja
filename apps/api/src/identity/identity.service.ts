import {
  Inject,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
  OnModuleInit,
} from '@nestjs/common';
import { PrivacyErasure } from '../platform/privacy-erasure';
import { randomUUID } from 'node:crypto';
import { CONFIG, RuntimeConfig } from '../config/config';
import { Database, Transaction } from '../platform/database';
import { CryptoPlatform } from '../platform/crypto/crypto-platform';
import { KeyIdentity } from '../platform/crypto/contracts';
import { PayloadContext } from '../platform/crypto/envelope';
import {
  AUTH_CONTROL,
  AuthControl,
  bindingDigest,
  SessionPrincipal,
} from '../platform/auth-control';
import { SafeLogger } from '../platform/safe-logger';
import { PlatformFailure } from '../platform/failure';
import { OidcProvider, VerifiedIdentity } from './oidc';
import { ProfileInput, object, profileInput } from './validation';
interface UserRow extends Record<string, unknown> {
  id: string;
  issuer: string;
  subject: string;
  status: string;
}
interface ProfileRow extends Record<string, unknown> {
  user_id: string;
  dek_id: string;
  dek_version: number;
  revision: number;
  payload: string;
  locale: string;
  timezone: string;
  preferred_currency: string;
  onboarding_state: ProfileInput['onboardingState'];
}
const initialProfile: ProfileInput = {
  displayName: null,
  locale: 'pt-BR',
  timezone: 'UTC',
  preferredCurrency: 'BRL',
  onboardingState: 'pending',
};
export type SecurityEvent =
  | 'account.created'
  | 'login.succeeded'
  | 'login.failed'
  | 'session.revoked'
  | 'session.refreshed'
  | 'sessions.revoked'
  | 'account.suspended'
  | 'deletion.requested'
  | 'account.deleted'
  | 'profile.updated';
@Injectable()
export class IdentityService implements OnModuleInit {
  constructor(
    private readonly database: Database,
    private readonly erasure: PrivacyErasure,
    private readonly crypto: CryptoPlatform,
    @Inject(AUTH_CONTROL) private readonly control: AuthControl,
    private readonly oidc: OidcProvider,
    private readonly logger: SafeLogger,
    @Inject(CONFIG) private readonly config: RuntimeConfig,
  ) {}
  async onModuleInit(): Promise<void> {
    for (const request of await this.control.deletions())
      await this.finishDeletion(request.userId);
  }
  private async audit(
    userId: string | null,
    event: SecurityEvent,
    result: 'success' | 'rejected' = 'success',
    tx?: Transaction,
  ): Promise<void> {
    await (tx ?? this.database).query(
      'INSERT INTO app.security_events(id,user_id,event,result) VALUES($1,$2,$3,$4)',
      [randomUUID(), userId, event, result],
    );
    await (tx ?? this.database).query(
      "DELETE FROM app.security_events WHERE created_at < clock_timestamp()-interval '90 days'",
    );
  }
  async begin(challenge: string, intent: 'login' | 'register') {
    await this.control.limit('auth.begin', 60, 60000);
    const value = await this.control.begin(challenge, intent);
    const authorizationUrl = await this.oidc.authorization(
      challenge,
      value.state,
      value.nonce,
    );
    return {
      challengeId: value.id,
      state: value.state,
      nonce: value.nonce,
      authorizationUrl,
      expiresIn: 300,
    };
  }
  async complete(
    id: string,
    state: string,
    nonce: string,
    code: string,
    verifier: string,
  ) {
    await this.control.limit('auth.complete', 60, 60000);
    try {
      const intent = await this.control.consume(id, state, nonce, verifier);
      const identity = await this.oidc.verify(code, verifier, state, nonce);
      const user = await this.account(identity, intent);
      const binding = bindingDigest(identity.issuer, identity.subject);
      await this.control.assertIdentity(user.id, binding);
      await this.keyCheck(user.id, binding);
      const tokens = await this.control.issue(
        user.id,
        binding,
        identity.authenticatedAt,
      );
      try {
        await this.audit(user.id, 'login.succeeded');
      } catch (error) {
        await this.control.revokeAll(user.id);
        throw error;
      }
      this.logger.event('identity.authentication', 'success');
      return tokens;
    } catch (error) {
      await this.audit(null, 'login.failed', 'rejected');
      this.logger.event('identity.authentication', 'rejected');
      if (
        error instanceof ServiceUnavailableException ||
        (error instanceof PlatformFailure &&
          ['unavailable', 'commit_unknown'].includes(error.code))
      )
        throw new ServiceUnavailableException();
      throw new UnauthorizedException();
    }
  }
  private async account(
    identity: VerifiedIdentity,
    intent: 'login' | 'register',
  ): Promise<UserRow> {
    let row = (
      await this.database.query<UserRow>(
        'SELECT * FROM app.users WHERE issuer=$1 AND subject=$2',
        [identity.issuer, identity.subject],
      )
    ).rows[0];
    if (!row && intent === 'register') {
      await this.control.limit('account.register', 100, 3600000);
      await this.database.query(
        "INSERT INTO app.users(id,issuer,subject,status) VALUES($1,$2,$3,'pending') ON CONFLICT(issuer,subject) DO NOTHING",
        [randomUUID(), identity.issuer, identity.subject],
      );
      row = (
        await this.database.query<UserRow>(
          'SELECT * FROM app.users WHERE issuer=$1 AND subject=$2',
          [identity.issuer, identity.subject],
        )
      ).rows[0];
    }
    if (
      !row ||
      !['pending', 'active'].includes(row.status) ||
      (intent === 'register' && row.status === 'active')
    )
      throw new UnauthorizedException();
    const binding = bindingDigest(identity.issuer, identity.subject);
    if (row.status === 'active') {
      await this.control.assertIdentity(row.id, binding);
      return row;
    }
    const existing = (
      await this.database.query<{ dek_id: string; dek_version: number }>(
        'SELECT dek_id,dek_version FROM app.user_data_keys WHERE user_id=$1 ORDER BY dek_version DESC LIMIT 1',
        [row.id],
      )
    ).rows[0];
    let key: KeyIdentity;
    if (existing) {
      key = {
        userId: row.id,
        dekId: existing.dek_id,
        version: existing.dek_version,
      };
      await this.crypto.keys.reconcilePending(key, binding);
    } else key = await this.crypto.keys.provision(row.id, binding);
    await this.control.bind(row.id, binding);
    return this.crypto.keys.withKey(key, binding, 'encrypt', async (scope) =>
      this.crypto.keys.transaction(scope, async (tx) => {
        const locked = (
          await tx.query<UserRow>(
            'SELECT * FROM app.users WHERE id=$1 FOR NO KEY UPDATE',
            [row!.id],
          )
        ).rows[0];
        if (
          !locked ||
          locked.issuer !== identity.issuer ||
          locked.subject !== identity.subject ||
          locked.status !== 'pending'
        )
          throw new PlatformFailure('fenced');
        const buffer = Buffer.from(
          JSON.stringify({ version: 1, displayName: null }),
        );
        try {
          const payload = await scope.encrypt(
            buffer,
            this.context(key, 1, initialProfile),
          );
          await this.owner(tx, locked.id);
          await tx.query(
            'INSERT INTO app.user_profiles VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',
            [
              locked.id,
              key.dekId,
              key.version,
              payload,
              initialProfile.locale,
              initialProfile.timezone,
              initialProfile.preferredCurrency,
              initialProfile.onboardingState,
            ],
          );
        } finally {
          buffer.fill(0);
        }
        tx.beforeCommit(() => this.control.assertIdentity(locked.id, binding));
        await tx.query(
          "UPDATE app.users SET status='active',updated_at=clock_timestamp() WHERE id=$1",
          [locked.id],
        );
        await this.audit(locked.id, 'account.created', 'success', tx);
        return { ...locked, status: 'active' };
      }),
    );
  }

  private async keyCheck(userId: string, binding: string): Promise<void> {
    const key = await this.crypto.lifecycle.active(userId);
    await this.crypto.keys.withKey(key, binding, 'decrypt', async () => {});
  }
  async authenticate(access: string): Promise<SessionPrincipal> {
    let principal: SessionPrincipal;
    try {
      principal = await this.control.resolve(access);
    } catch (error) {
      if (error instanceof PlatformFailure && error.code === 'unavailable')
        throw new ServiceUnavailableException();
      throw new UnauthorizedException();
    }
    const row = (
      await this.database.query<UserRow>(
        'SELECT * FROM app.users WHERE id=$1',
        [principal.userId],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== 'active' ||
      bindingDigest(row.issuer, row.subject) !== principal.binding
    )
      throw new UnauthorizedException();
    try {
      await this.keyCheck(principal.userId, principal.binding);
    } catch {
      throw new ServiceUnavailableException();
    }
    return principal;
  }
  async refresh(token: string) {
    await this.control.limit('auth.refresh', 120, 60000);
    const tokens = await this.control.refresh(token);
    try {
      const principal = await this.authenticate(tokens.accessToken);
      await this.audit(principal.userId, 'session.refreshed');
      return tokens;
    } catch (error) {
      await this.control.revoke(
        (await this.control.resolve(tokens.accessToken)).sessionId,
      );
      throw error;
    }
  }
  async logout(principal: SessionPrincipal): Promise<void> {
    await this.control.assertSession(principal);
    await this.control.revoke(principal.sessionId);
    await this.audit(principal.userId, 'session.revoked');
  }
  stepUp(principal: SessionPrincipal): void {
    if (Date.now() - principal.authenticatedAt > 300000)
      throw new ForbiddenException();
  }
  async revokeAll(principal: SessionPrincipal): Promise<void> {
    await this.control.assertSession(principal);
    this.stepUp(principal);
    await this.control.revokeAll(principal.userId);
    await this.audit(principal.userId, 'sessions.revoked');
  }
  async assertOwner(
    principal: SessionPrincipal,
    userId: string,
  ): Promise<void> {
    if (principal.userId !== userId) throw new ForbiddenException();
    await this.control.assertSession(principal);
    await this.control.assertIdentity(principal.userId, principal.binding);
  }
  private async owner(tx: Transaction, userId: string): Promise<void> {
    await tx.query("SELECT set_config('forja.user_id',$1,true)", [userId]);
  }
  private context(
    key: KeyIdentity,
    revision: number,
    profile: ProfileInput,
  ): PayloadContext {
    return {
      environment: this.config.crypto.environmentId,
      userId: key.userId,
      entityKind: 'identity.profile',
      entityId: key.userId,
      slot: 'private',
      revision,
      metadataSchema: 1,
      metadata: [
        profile.locale,
        profile.timezone,
        profile.preferredCurrency,
        profile.onboardingState,
      ],
      dekId: key.dekId,
      dekVersion: key.version,
      payloadSchema: 1,
    };
  }
  async profile(principal: SessionPrincipal) {
    await this.assertOwner(principal, principal.userId);
    return this.database.transaction(async (tx) => {
      await this.owner(tx, principal.userId);
      const row = (
        await tx.query<ProfileRow>(
          'SELECT * FROM app.user_profiles WHERE user_id=$1',
          [principal.userId],
        )
      ).rows[0];
      if (!row) throw new ServiceUnavailableException();
      const metadata: ProfileInput = {
        displayName: null,
        locale: row.locale,
        timezone: row.timezone,
        preferredCurrency: row.preferred_currency.trim(),
        onboardingState: row.onboarding_state,
      };
      tx.beforeCommit(() => this.control.assertSession(principal));
      return this.crypto.keys.withKey(
        {
          userId: principal.userId,
          dekId: row.dek_id,
          version: row.dek_version,
        },
        principal.binding,
        'decrypt',
        async (scope) => {
          const decrypted = await scope.decrypt(
            row.payload,
            this.context(scope.identity, row.revision, metadata),
          );
          const decoded = object(
            JSON.parse(decrypted.toString('utf8')) as unknown,
            ['version', 'displayName'],
          );
          if (decoded['version'] !== 1) throw new PlatformFailure('integrity');
          const values = profileInput({
            ...metadata,
            displayName: decoded['displayName'],
          });
          return {
            userId: principal.userId,
            revision: row.revision,
            ...values,
          };
        },
        tx,
      );
    });
  }
  async update(
    principal: SessionPrincipal,
    revision: number,
    profile: ProfileInput,
  ) {
    await this.assertOwner(principal, principal.userId);
    await this.control.limit(`profile.${principal.userId}`, 30, 60000);
    // Authenticate existing ciphertext/metadata before replacing it.
    const existing = await this.profile(principal);
    if (existing.revision !== revision) throw new ConflictException();
    const key = await this.crypto.lifecycle.active(principal.userId);
    await this.crypto.keys.withKey(
      key,
      principal.binding,
      'encrypt',
      async (scope) => {
        const buffer = Buffer.from(
          JSON.stringify({ version: 1, displayName: profile.displayName }),
        );
        try {
          const payload = await scope.encrypt(
            buffer,
            this.context(key, revision + 1, profile),
          );
          await this.crypto.keys.transaction(scope, async (tx) => {
            await this.owner(tx, principal.userId);
            tx.beforeCommit(() => this.control.assertSession(principal));
            const result = await tx.query(
              'UPDATE app.user_profiles SET dek_id=$2,dek_version=$3,revision=revision+1,payload=$4,locale=$5,timezone=$6,preferred_currency=$7,onboarding_state=$8 WHERE user_id=$1 AND revision=$9',
              [
                principal.userId,
                key.dekId,
                key.version,
                payload,
                profile.locale,
                profile.timezone,
                profile.preferredCurrency,
                profile.onboardingState,
                revision,
              ],
            );
            if (result.rowCount !== 1) throw new PlatformFailure('conflict');
            await this.audit(
              principal.userId,
              'profile.updated',
              'success',
              tx,
            );
          });
        } finally {
          buffer.fill(0);
        }
      },
    );
    return this.profile(principal);
  }
  async deletion(principal: SessionPrincipal): Promise<void> {
    await this.control.assertSession(principal);
    this.stepUp(principal);
    await this.control.deny(principal.userId, principal.binding, 'deletion');
    await this.finishDeletion(principal.userId);
  }
  private async finishDeletion(userId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        "UPDATE app.users SET status='deletion-requested',updated_at=clock_timestamp() WHERE id=$1 AND status<>'deleted'",
        [userId],
      );
      await this.audit(userId, 'deletion.requested', 'success', tx);
    });
    await this.crypto.lifecycle.fence(userId);
    await this.crypto.lifecycle.transition(userId, 'deleted');
    await this.database.transaction(async (tx) => {
      await this.owner(tx, userId);
      await this.erasure.erase(tx, userId);
      await tx.query('DELETE FROM app.user_profiles WHERE user_id=$1', [
        userId,
      ]);
      await tx.query('DELETE FROM app.user_data_keys WHERE user_id=$1', [
        userId,
      ]);
      await tx.query(
        "UPDATE app.users SET status='deleted',issuer=NULL,subject=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [userId],
      );
      await this.audit(userId, 'account.deleted', 'success', tx);
    });
    await this.control.deleted(userId);
  }
  // Trusted server capability; never exposed as an end-user/admin HTTP command.
  async suspendVerified(principal: SessionPrincipal): Promise<void> {
    await this.control.assertSession(principal);
    await this.control.deny(principal.userId, principal.binding, 'suspension');
    await this.crypto.lifecycle.fence(principal.userId);
    await this.crypto.lifecycle.transition(principal.userId, 'revoked');
    await this.database.query(
      "UPDATE app.users SET status='suspended',updated_at=clock_timestamp() WHERE id=$1",
      [principal.userId],
    );
    await this.audit(principal.userId, 'account.suspended');
  }
}
