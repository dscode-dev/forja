import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLifecycle } from '../src/platform/crypto/local-lifecycle';
import { LocalAuthControl, bindingDigest } from '../src/platform/auth-control';
import { oidcSettings } from '../src/identity/oidc';
import { profileInput } from '../src/identity/validation';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'forja-auth-test-')),
    path = join(dir, 'control.sqlite'),
    authority = randomUUID();
  const lifecycle = new LocalLifecycle(path, authority, 'forja-test', true);
  const user = randomUUID(),
    binding = bindingDigest('https://fixture.invalid', 'opaque-subject');
  const key = lifecycle.createPending(user, binding);
  lifecycle.enroll(key, '1'.repeat(64));
  lifecycle.activate(key, '1'.repeat(64));
  const control = new LocalAuthControl(path, authority, 'forja-test');
  control.bind(user, binding);
  return {
    dir,
    path,
    authority,
    user,
    binding,
    lifecycle,
    control,
    close: () => {
      control.close();
      lifecycle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('OIDC challenge is bound to nonce/state/PKCE, expires and is consumed once', () => {
  const f = fixture();
  try {
    const verifier = 'x'.repeat(43),
      challenge = createHash('sha256').update(verifier).digest('base64url');
    const value = f.control.begin(challenge, 'register');
    for (const args of [
      [value.id, 'y'.repeat(43), value.nonce, verifier],
      [value.id, value.state, 'y'.repeat(43), verifier],
      [value.id, value.state, value.nonce, 'y'.repeat(43)],
    ])
      assert.throws(() =>
        f.control.consume(args[0]!, args[1]!, args[2]!, args[3]!),
      );
    assert.equal(
      f.control.consume(value.id, value.state, value.nonce, verifier),
      'register',
    );
    assert.throws(() =>
      f.control.consume(value.id, value.state, value.nonce, verifier),
    );
  } finally {
    f.close();
  }
});
test('opaque access/refresh sessions persist revocation, rotate once and revoke family on replay', () => {
  const f = fixture();
  try {
    const first = f.control.issue(f.user, f.binding, Date.now());
    const principal = f.control.resolve(first.accessToken);
    assert.equal(principal.userId, f.user);
    const second = f.control.refresh(first.refreshToken);
    assert.throws(() => f.control.resolve(first.accessToken));
    assert.throws(() => f.control.assertSession(principal));
    f.control.close();
    const reopened = new LocalAuthControl(f.path, f.authority, 'forja-test');
    try {
      assert.equal(reopened.resolve(second.accessToken).userId, f.user);
      assert.throws(() => reopened.refresh(first.refreshToken));
      assert.throws(() => reopened.resolve(second.accessToken));
      assert.throws(() => reopened.refresh(second.refreshToken));
      const third = reopened.issue(f.user, f.binding, Date.now());
      reopened.revokeAll(f.user);
      assert.throws(() => reopened.resolve(third.accessToken));
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
test('expiry, identity tampering, denial and durable limits fail closed', (context) => {
  const f = fixture();
  try {
    const now = Date.now(),
      tokens = f.control.issue(f.user, f.binding, now);
    context.mock.method(Date, 'now', () => now + 300001);
    assert.throws(() => f.control.resolve(tokens.accessToken));
    const rotated = f.control.refresh(tokens.refreshToken);
    context.mock.method(Date, 'now', () => now + 7 * 86400000 + 300002);
    assert.throws(() => f.control.refresh(rotated.refreshToken));
    context.mock.restoreAll();
    assert.throws(() => f.control.assertIdentity(f.user, '2'.repeat(64)));
    f.control.limit('fixture', 1, 60000);
    assert.throws(() => f.control.limit('fixture', 1, 60000));
    f.control.deny(f.user, f.binding, 'deletion');
    assert.throws(() => f.control.issue(f.user, f.binding, Date.now()));
    assert.equal(f.control.deletions().length, 1);
    f.control.deleted(f.user);
    assert.equal(f.control.deletions().length, 0);
  } finally {
    context.mock.restoreAll();
    f.close();
  }
});
test('OIDC configuration and profile codecs reject unsafe URLs, mass assignment and invalid metadata', () => {
  assert.equal(oidcSettings({}), undefined);
  assert.throws(() =>
    oidcSettings({
      OIDC_ISSUER: 'http://issuer.invalid',
      OIDC_CLIENT_ID: 'public',
      OIDC_REDIRECT_URI: 'com.forja:/callback',
    }),
  );
  assert.throws(() =>
    profileInput({
      displayName: 'test',
      locale: 'pt-BR',
      timezone: 'INVALID',
      preferredCurrency: 'BRL',
      onboardingState: 'pending',
    }),
  );
  assert.throws(() =>
    profileInput({
      displayName: 'test',
      locale: 'pt-BR',
      timezone: 'UTC',
      preferredCurrency: 'BRL',
      onboardingState: 'pending',
      userId: randomUUID(),
    }),
  );
  const profile = profileInput({
    displayName: ' Nome ',
    locale: 'pt-BR',
    timezone: 'UTC',
    preferredCurrency: 'BRL',
    onboardingState: 'pending',
  });
  assert.equal(profile.displayName, 'Nome');
});
