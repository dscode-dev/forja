import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomBytes, createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { Database, Transaction } from '../../src/platform/database';
import type { QueryResultRow } from 'pg';
import { CryptoPlatform } from '../../src/platform/crypto/crypto-platform';
import { PlatformFailure } from '../../src/platform/failure';
import { SafeLogger } from '../../src/platform/safe-logger';
import { SafeErrorFilter } from '../../src/platform/error-filter';
import { AUTH_CONTROL, AuthControl } from '../../src/platform/auth-control';
import { IdentityService } from '../../src/identity/identity.service';
import { migrationConfig } from '../../src/config/config';
import { oidcFixture } from '../fixtures/oidc-server';
async function harness() {
  const fixture = await oidcFixture(process.env['FORJA_TEST_TLS_DIRECTORY']!);
  process.env['OIDC_ISSUER'] = fixture.issuer;
  process.env['OIDC_CLIENT_ID'] = 'forja-test-client';
  process.env['OIDC_REDIRECT_URI'] = 'com.darlan.forja.dev:/auth/callback';
  const lines: string[] = [];
  const known = new Set<string>();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SafeLogger)
    .useValue(new SafeLogger((line) => lines.push(line)))
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({
    logger: false,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '8kb', strict: true });
  app.useGlobalFilters(
    new SafeErrorFilter(new SafeLogger((line) => lines.push(line))),
  );
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl(),
    db = module.get(Database),
    owner = new Pool(migrationConfig().database),
    identity = module.get(IdentityService),
    control = module.get<AuthControl>(AUTH_CONTROL),
    platform = module.get(CryptoPlatform);
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    token?: string,
  ) {
    return fetch(url + '/v1/' + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function flow(
    subject: string,
    intent: 'register' | 'login' = 'register',
    override: Record<string, unknown> = {},
    badSignature = false,
  ) {
    const verifier = randomBytes(32).toString('base64url');
    const begin = await request('auth/begin', 'POST', {
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      intent,
    });
    assert.equal(begin.status, 200);
    const challenge = (await begin.json()) as {
      challengeId: string;
      state: string;
      nonce: string;
      authorizationUrl: string;
    };
    const code = fixture.grant(
      challenge.authorizationUrl,
      subject,
      override,
      badSignature,
    );
    const body = {
      challengeId: challenge.challengeId,
      state: challenge.state,
      nonce: challenge.nonce,
      code,
      codeVerifier: verifier,
    };
    return { body, complete: () => request('auth/complete', 'POST', body) };
  }
  async function login(
    subject: string,
    intent: 'register' | 'login' = 'register',
  ) {
    const f = await flow(subject, intent),
      response = await f.complete();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const tokens = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    assert.deepEqual(Object.keys(tokens).sort(), [
      'accessToken',
      'expiresIn',
      'refreshToken',
      'tokenType',
    ]);
    const principal = await identity.authenticate(tokens.accessToken);
    known.add(principal.userId);
    return { ...tokens, principal };
  }
  return {
    fixture,
    lines,
    module,
    app,
    db,
    owner,
    identity,
    control,
    platform,
    request,
    flow,
    login,
    async close() {
      try {
        const users = await owner.query(
          'SELECT id FROM app.users WHERE issuer=$1 OR id=ANY($2::uuid[])',
          [fixture.issuer, [...known]],
        );
        for (const row of users.rows)
          await db.transaction(async (tx) => {
            await tx.query("SELECT set_config('forja.user_id',$1,true)", [
              row.id,
            ]);
            await tx.query('DELETE FROM app.user_profiles WHERE user_id=$1', [
              row.id,
            ]);
          });
        const ids = users.rows.map((row) => row.id);
        await owner.query(
          'DELETE FROM app.security_events WHERE user_id=ANY($1::uuid[]) OR user_id IS NULL',
          [ids],
        );
        await owner.query(
          'DELETE FROM app.user_data_keys WHERE user_id=ANY($1::uuid[])',
          [ids],
        );
        await owner.query('DELETE FROM app.users WHERE id=ANY($1::uuid[])', [
          ids,
        ]);
      } finally {
        await owner.end();
        await app.close();
        await fixture.close();
        delete process.env['OIDC_ISSUER'];
        delete process.env['OIDC_CLIENT_ID'];
        delete process.env['OIDC_REDIRECT_URI'];
      }
    },
  };
}
test('real HTTPS OIDC account/session/profile paths enforce binding, replay, ownership and safe transport', async () => {
  const h = await harness();
  try {
    const a = await h.login('opaque-user-a'),
      b = await h.login('opaque-user-b');
    const profile = await h.request('me', 'GET', undefined, a.accessToken);
    assert.equal(profile.status, 200);
    const current = (await profile.json()) as {
      revision: number;
      userId: string;
    };
    assert.equal(current.userId, a.principal.userId);
    const values = {
      displayName: 'S2_PROFILE_CANARY_03',
      locale: 'pt-BR',
      timezone: 'America/Recife',
      preferredCurrency: 'BRL',
      onboardingState: 'pending',
    };
    const updated = await h.request(
      'me/profile',
      'PUT',
      { revision: current.revision, profile: values },
      a.accessToken,
    );
    assert.equal(updated.status, 200);
    assert.equal(
      ((await updated.json()) as { displayName: string }).displayName,
      values.displayName,
    );
    const visible = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a.principal.userId,
      ]);
      const rows = await tx.query('SELECT * FROM app.user_profiles');
      const foreign = await tx.query(
        'SELECT * FROM app.user_profiles WHERE user_id=$1',
        [b.principal.userId],
      );
      return { rows: rows.rows, foreign: foreign.rows };
    });
    assert.equal(visible.rows.length, 1);
    assert.equal(visible.rows[0]?.['user_id'], a.principal.userId);
    assert.equal(
      JSON.stringify(visible.rows).includes(values.displayName),
      false,
    );
    assert.equal(visible.foreign.length, 0);
    await assert.rejects(
      h.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('forja.user_id',$1,true)", [
          a.principal.userId,
        ]);
        await tx.query('UPDATE app.user_profiles SET user_id=$1', [
          b.principal.userId,
        ]);
      }),
    );

    await assert.rejects(
      h.identity.assertOwner(a.principal, b.principal.userId),
    );
    assert.equal(
      (
        await h.request(
          'me/profile',
          'PUT',
          { revision: 2, profile: { ...values, userId: b.principal.userId } },
          a.accessToken,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request('auth/begin', 'POST', {
          codeChallenge: 'x'.repeat(43),
          intent: 'login',
          private: 'S3_AUTH_CANARY_03',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request('auth/refresh', 'POST', {
          refreshToken: 'x'.repeat(9000),
        })
      ).status,
      413,
    );
    const duplicate = await h.flow('opaque-user-a');
    assert.equal((await duplicate.complete()).status, 401);
    const missing = await h.flow('opaque-unknown', 'login');
    const failed = await missing.complete();
    assert.equal(failed.status, 401);
    assert.deepEqual(await failed.json(), { code: 'REQUEST_REJECTED' });
    const renewed = await h.request('auth/refresh', 'POST', {
      refreshToken: a.refreshToken,
    });
    assert.equal(renewed.status, 200);
    const rotated = (await renewed.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    assert.equal(
      (await h.request('me', 'GET', undefined, a.accessToken)).status,
      401,
    );
    const replay = await h.request('auth/refresh', 'POST', {
      refreshToken: a.refreshToken,
    });
    assert.equal(replay.status, 401);
    assert.equal(
      (await h.request('me', 'GET', undefined, rotated.accessToken)).status,
      401,
    );
    assert.equal(
      (
        await h.request('auth/refresh', 'POST', {
          refreshToken: rotated.refreshToken,
        })
      ).status,
      401,
    );
    assert.equal(
      (await h.request('auth/logout', 'POST', {}, b.accessToken)).status,
      204,
    );
    assert.equal(
      (await h.request('me', 'GET', undefined, b.accessToken)).status,
      401,
    );
    const a2 = await h.login('opaque-user-a', 'login'),
      a3 = await h.login('opaque-user-a', 'login');
    assert.equal(
      (await h.request('auth/revoke-all', 'POST', {}, a2.accessToken)).status,
      204,
    );
    assert.equal(
      (await h.request('me', 'GET', undefined, a3.accessToken)).status,
      401,
    );
    const a4 = await h.login('opaque-user-a', 'login');
    const stale = await h.control.issue(
      a4.principal.userId,
      a4.principal.binding,
      Date.now() - 300001,
    );
    const staleRefresh = await h.request('auth/refresh', 'POST', {
      refreshToken: stale.refreshToken,
    });
    assert.equal(staleRefresh.status, 200);
    const staleTokens = (await staleRefresh.json()) as { accessToken: string };
    assert.equal(
      (await h.request('auth/revoke-all', 'POST', {}, staleTokens.accessToken))
        .status,
      403,
    );
    assert.equal(
      (await h.request('me', 'DELETE', {}, staleTokens.accessToken)).status,
      403,
    );
    const race = await h.login('opaque-user-a', 'login');
    const responses = await Promise.all([
      h.request('auth/refresh', 'POST', { refreshToken: race.refreshToken }),
      h.request('auth/refresh', 'POST', { refreshToken: race.refreshToken }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 401],
    );
    const once = (await responses
      .find((response) => response.status === 200)!
      .json()) as { accessToken: string };
    assert.equal(
      (await h.request('me', 'GET', undefined, once.accessToken)).status,
      401,
    );
    // A DB-write attacker cannot change the authoritative principal or borrow its profile key.
    await h.owner.query('UPDATE app.users SET subject=$2 WHERE id=$1', [
      a4.principal.userId,
      'attacker-subject',
    ]);
    assert.equal(
      (await h.request('me', 'GET', undefined, a4.accessToken)).status,
      401,
    );
    const mapping = await h.flow('attacker-subject', 'login');
    assert.equal((await mapping.complete()).status, 401);
    await h.owner.query('UPDATE app.users SET subject=$2 WHERE id=$1', [
      a4.principal.userId,
      'opaque-user-a',
    ]);
    const keys = await h.owner.query(
      'SELECT * FROM app.user_data_keys WHERE user_id=$1',
      [a4.principal.userId],
    );
    assert.equal(keys.rows.length, 1);
    const saved = keys.rows[0]!.wrapped_dek as Buffer;
    await h.owner.query(
      'UPDATE app.user_data_keys SET wrapped_dek=$2 WHERE user_id=$1',
      [a4.principal.userId, Buffer.alloc(saved.length)],
    );
    assert.equal(
      (await h.request('me', 'GET', undefined, a4.accessToken)).status,
      503,
    );
    await h.owner.query(
      'UPDATE app.user_data_keys SET wrapped_dek=$2 WHERE user_id=$1',
      [a4.principal.userId, saved],
    );
    const snapshot = await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a4.principal.userId,
      ]);
      const row = (
        await tx.query('SELECT * FROM app.user_profiles WHERE user_id=$1', [
          a4.principal.userId,
        ])
      ).rows[0]!;
      await tx.query('DELETE FROM app.user_profiles WHERE user_id=$1', [
        a4.principal.userId,
      ]);
      await tx.query('DELETE FROM app.user_data_keys WHERE user_id=$1', [
        a4.principal.userId,
      ]);
      return row;
    });
    assert.equal(
      (await h.request('me', 'GET', undefined, a4.accessToken)).status,
      503,
    );
    const keyRow = keys.rows[0]!;
    await h.owner.query(
      'INSERT INTO app.user_data_keys VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        keyRow.user_id,
        keyRow.dek_id,
        keyRow.dek_version,
        keyRow.wrap_format,
        keyRow.provider_id,
        keyRow.kek_ref,
        keyRow.kek_version,
        keyRow.wrapped_dek,
        keyRow.state,
        keyRow.created_at,
      ],
    );
    await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a4.principal.userId,
      ]);
      await tx.query(
        'INSERT INTO app.user_profiles VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          snapshot['user_id'],
          snapshot['dek_id'],
          snapshot['dek_version'],
          snapshot['revision'],
          snapshot['payload'],
          snapshot['locale'],
          snapshot['timezone'],
          snapshot['preferred_currency'],
          snapshot['onboarding_state'],
        ],
      );
    });
    await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a4.principal.userId,
      ]);
      await tx.query(
        "UPDATE app.user_profiles SET timezone='UTC' WHERE user_id=$1",
        [a4.principal.userId],
      );
    });
    assert.equal(
      (await h.request('me', 'GET', undefined, a4.accessToken)).status,
      503,
    );
    await h.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('forja.user_id',$1,true)", [
        a4.principal.userId,
      ]);
      await tx.query(
        "UPDATE app.user_profiles SET timezone='America/Recife' WHERE user_id=$1",
        [a4.principal.userId],
      );
    });
    const audit = await h.owner.query(
      'SELECT event,result FROM app.security_events WHERE user_id=$1',
      [a4.principal.userId],
    );
    assert.ok(audit.rows.some((row) => row.event === 'account.created'));
    for (const secret of [
      values.displayName,
      'S3_AUTH_CANARY_03',
      a.accessToken,
      a.refreshToken,
      b.accessToken,
    ])
      assert.equal(JSON.stringify(h.lines).includes(secret), false);
    assert.equal(JSON.stringify(a).includes('wrapped_dek'), false);
  } finally {
    await h.close();
  }
});
test('signed OIDC tokens reject wrong issuer/audience/nonce/expiry/auth_time/signature and challenge replay', async () => {
  const h = await harness();
  try {
    for (const override of [
      { iss: 'https://foreign.invalid' },
      { aud: 'foreign-client' },
      { nonce: 'foreign-nonce' },
      { exp: 1 },
      { auth_time: 1 },
      { sub: 'email@example.invalid' },
    ]) {
      const flow = await h.flow('opaque-invalid', 'register', override);
      assert.equal((await flow.complete()).status, 401);
    }
    const signature = await h.flow('opaque-invalid', 'register', {}, true);
    assert.equal((await signature.complete()).status, 401);
    const flow = await h.flow('opaque-once');
    assert.equal((await flow.complete()).status, 200);
    assert.equal((await flow.complete()).status, 401);
    const first = await h.flow('opaque-concurrent'),
      second = await h.flow('opaque-concurrent');
    const registrations = await Promise.all([
      first.complete(),
      second.complete(),
    ]);
    assert.deepEqual(
      registrations.map((response) => response.status).sort(),
      [200, 401],
    );
    const pkce = await h.flow('opaque-pkce');
    assert.equal(
      (
        await h.request('auth/complete', 'POST', {
          ...pkce.body,
          codeVerifier: 'x'.repeat(43),
        })
      ).status,
      401,
    );
    const result = await h.owner.query(
      'SELECT count(*)::int AS n FROM app.users WHERE issuer=$1',
      [h.fixture.issuer],
    );
    assert.equal(result.rows[0].n, 2);
    assert.equal(
      JSON.stringify(h.lines).includes('email@example.invalid'),
      false,
    );
  } finally {
    await h.close();
  }
});
test('key enrollment failures recover without active unusable accounts; deletion and suspension deny independently', async (context) => {
  const h = await harness();
  try {
    const randomFailure = await h.flow('opaque-generation');
    context.mock.method(crypto, 'randomBytes', () => {
      throw new Error('S3_AUTH_KEY_FAILURE_CANARY_03');
    });
    assert.equal((await randomFailure.complete()).status, 503);
    context.mock.restoreAll();
    const wrappingFailure = await h.flow('opaque-wrapping');
    context.mock.method(h.platform.provider, 'wrap', async () => {
      throw new PlatformFailure('unavailable');
    });
    assert.equal((await wrappingFailure.complete()).status, 503);
    context.mock.restoreAll();
    const insertFailure = await h.flow('opaque-insert'),
      query = h.db.query.bind(h.db);
    context.mock.method(
      h.db,
      'query',
      async (sql: string, params?: readonly unknown[]) => {
        if (sql.startsWith('INSERT INTO app.user_data_keys'))
          throw new PlatformFailure('unavailable');
        return query(sql, params);
      },
    );
    assert.equal((await insertFailure.complete()).status, 503);
    context.mock.restoreAll();
    const commitFailure = await h.flow('opaque-commit'),
      transaction = h.db.transaction.bind(h.db);
    context.mock.method(
      h.db,
      'transaction',
      async (operation: (tx: Transaction) => Promise<unknown>) =>
        transaction(async (tx) => {
          let activate = false;
          tx.beforeCommit(() => {
            if (activate) throw new PlatformFailure('unavailable');
          });
          const wrapped: Transaction = {
            ...tx,
            query: async <R extends QueryResultRow>(
              sql: string,
              parameters?: readonly unknown[],
            ) => {
              if (sql.includes("UPDATE app.users SET status='active'"))
                activate = true;
              return tx.query<R>(sql, parameters);
            },
          };
          return operation(wrapped);
        }),
    );
    assert.equal((await commitFailure.complete()).status, 503);
    context.mock.restoreAll();
    const states = await h.owner.query(
      'SELECT status FROM app.users WHERE issuer=$1',
      [h.fixture.issuer],
    );
    assert.equal(states.rows.length, 4);
    assert.ok(states.rows.every((row) => row.status === 'pending'));
    for (const subject of [
      'opaque-generation',
      'opaque-wrapping',
      'opaque-insert',
      'opaque-commit',
    ])
      await h.login(subject);
    const account = await h.login('opaque-delete');
    await h.control.deny(
      account.principal.userId,
      account.principal.binding,
      'deletion',
    );
    assert.equal(
      (await h.request('me', 'GET', undefined, account.accessToken)).status,
      401,
    );
    await h.identity.onModuleInit();
    assert.equal(
      (
        await h.owner.query('SELECT status FROM app.users WHERE id=$1', [
          account.principal.userId,
        ])
      ).rows[0].status,
      'deleted',
    );
    const erased = await h.owner.query(
      'SELECT issuer,subject FROM app.users WHERE id=$1',
      [account.principal.userId],
    );
    assert.equal(erased.rows[0].issuer, null);
    assert.equal(erased.rows[0].subject, null);
    assert.equal(
      (
        await h.owner.query(
          'SELECT count(*)::int AS n FROM app.user_data_keys WHERE user_id=$1',
          [account.principal.userId],
        )
      ).rows[0].n,
      0,
    );
    const suspended = await h.login('opaque-suspend');
    await h.identity.suspendVerified(suspended.principal);
    assert.equal(
      (await h.request('me', 'GET', undefined, suspended.accessToken)).status,
      401,
    );
    const again = await h.flow('opaque-suspend', 'login');
    assert.equal((await again.complete()).status, 401);
    const directDelete = await h.login('opaque-direct-delete');
    assert.equal(
      (await h.request('me', 'DELETE', {}, directDelete.accessToken)).status,
      204,
    );
    assert.equal(
      JSON.stringify(h.lines).includes('S3_AUTH_KEY_FAILURE_CANARY_03'),
      false,
    );
  } finally {
    context.mock.restoreAll();
    await h.close();
  }
});
