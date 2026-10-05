import { createServer } from 'node:https';
import {
  generateKeyPairSync,
  sign,
  randomBytes,
  createHash,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
const fixtureEntropy = randomBytes;
interface Grant {
  subject: string;
  nonce: string;
  challenge: string;
  override: Record<string, unknown>;
  badSignature: boolean;
}
export async function oidcFixture(directory: string) {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const grants = new Map<string, Grant>();
  let issuer = '';
  const server = createServer(
    {
      key: readFileSync(join(directory, 'key.pem')),
      cert: readFileSync(join(directory, 'cert.pem')),
    },
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/.well-known/openid-configuration') {
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: issuer + '/authorize',
            token_endpoint: issuer + '/token',
            jwks_uri: issuer + '/jwks',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          }),
        );
        return;
      }
      if (request.url === '/jwks') {
        response.end(
          JSON.stringify({
            keys: [
              {
                ...pair.publicKey.export({ format: 'jwk' }),
                kid: 'fixture',
                alg: 'RS256',
                use: 'sig',
              },
            ],
          }),
        );
        return;
      }
      if (request.url !== '/token' || request.method !== 'POST') {
        response.statusCode = 404;
        response.end('{}');
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const params = new URLSearchParams(body),
          code = params.get('code') ?? '',
          grant = grants.get(code);
        grants.delete(code);
        if (
          !grant ||
          params.get('client_id') !== 'forja-test-client' ||
          params.get('grant_type') !== 'authorization_code' ||
          createHash('sha256')
            .update(params.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        ) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const now = Math.floor(Date.now() / 1000),
          claims = {
            iss: issuer,
            sub: grant.subject,
            aud: 'forja-test-client',
            iat: now,
            exp: now + 300,
            auth_time: now,
            nonce: grant.nonce,
            ...grant.override,
          };
        const input =
          Buffer.from(
            JSON.stringify({ alg: 'RS256', kid: 'fixture', typ: 'JWT' }),
          ).toString('base64url') +
          '.' +
          Buffer.from(JSON.stringify(claims)).toString('base64url');
        const signature = grant.badSignature
          ? fixtureEntropy(256)
          : sign('RSA-SHA256', Buffer.from(input), pair.privateKey);
        response.end(
          JSON.stringify({
            access_token: fixtureEntropy(32).toString('base64url'),
            token_type: 'Bearer',
            expires_in: 300,
            id_token: input + '.' + signature.toString('base64url'),
          }),
        );
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = 'https://127.0.0.1:' + (server.address() as AddressInfo).port;
  return {
    issuer,
    grant(
      authorizationUrl: string,
      subject: string,
      override: Record<string, unknown> = {},
      badSignature = false,
    ) {
      const url = new URL(authorizationUrl);
      if (
        url.origin !== issuer ||
        url.searchParams.get('code_challenge_method') !== 'S256'
      )
        throw new Error('Invalid fixture protocol');
      const code = fixtureEntropy(32).toString('base64url');
      grants.set(code, {
        subject,
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        override,
        badSignature,
      });
      return code;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
