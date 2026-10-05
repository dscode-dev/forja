import { PrivacyErasure } from '../../src/platform/privacy-erasure';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { Database } from '../../src/platform/database';
import { CryptoPlatform } from '../../src/platform/crypto/crypto-platform';
import { SafeLogger } from '../../src/platform/safe-logger';
import { SafeErrorFilter } from '../../src/platform/error-filter';
import { AUTH_CONTROL, AuthControl } from '../../src/platform/auth-control';
import { IdentityService } from '../../src/identity/identity.service';
import { migrationConfig } from '../../src/config/config';
import { oidcFixture } from './oidc-server';
export async function harness() {
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
            await tx.query(
              "UPDATE app.users SET status='deletion-requested' WHERE id=$1 AND status<>'deleted'",
              [row.id],
            );
            await app.get(PrivacyErasure).erase(tx, row.id);
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
