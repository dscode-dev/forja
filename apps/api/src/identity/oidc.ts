import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as client from 'openid-client';
export interface VerifiedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly authenticatedAt: number;
}
export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirect: string;
}
export function oidcSettings(
  env: NodeJS.ProcessEnv = process.env,
): OidcSettings | undefined {
  const names = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_REDIRECT_URI'];
  if (names.every((name) => !env[name])) return undefined;
  try {
    const issuer = new URL(env['OIDC_ISSUER']!);
    const redirect = new URL(env['OIDC_REDIRECT_URI']!);
    const clientId = env['OIDC_CLIENT_ID']!;
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      !clientId ||
      clientId.length > 255 ||
      /[\s\u0000-\u001f]/u.test(clientId) ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash ||
      !(
        redirect.protocol === 'https:' ||
        /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/u.test(redirect.protocol)
      )
    )
      throw new Error();
    return { issuer: env['OIDC_ISSUER']!, clientId, redirect: redirect.href };
  } catch {
    throw new ServiceUnavailableException();
  }
}
@Injectable()
export class OidcProvider {
  private readonly settings = oidcSettings();
  private configuration: Promise<client.Configuration> | undefined;
  private async config(): Promise<client.Configuration> {
    if (!this.settings) throw new ServiceUnavailableException();
    if (!this.configuration)
      this.configuration = client
        .discovery(
          new URL(this.settings.issuer),
          this.settings.clientId,
          {
            token_endpoint_auth_method: 'none',
            id_token_signed_response_alg: 'RS256',
          },
          client.None(),
          { timeout: 5 },
        )
        .then((config) => {
          const metadata = config.serverMetadata();
          if (
            metadata.issuer !== this.settings!.issuer ||
            !metadata.code_challenge_methods_supported?.includes('S256')
          )
            throw new Error();
          for (const endpoint of [
            metadata.authorization_endpoint,
            metadata.token_endpoint,
            metadata.jwks_uri,
          ]) {
            if (!endpoint) throw new Error();
            const url = new URL(endpoint);
            if (
              url.protocol !== 'https:' ||
              url.username ||
              url.password ||
              url.hash
            )
              throw new Error();
          }
          client.enableNonRepudiationChecks(config);
          return config;
        })
        .catch(() => {
          this.configuration = undefined;
          throw new ServiceUnavailableException();
        });
    return this.configuration;
  }
  async authorization(
    challenge: string,
    state: string,
    nonce: string,
  ): Promise<string> {
    return client.buildAuthorizationUrl(await this.config(), {
      redirect_uri: this.settings!.redirect,
      response_type: 'code',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      max_age: '300',
      prompt: 'login',
    }).href;
  }
  async verify(
    code: string,
    verifier: string,
    state: string,
    nonce: string,
  ): Promise<VerifiedIdentity> {
    const config = await this.config();
    try {
      const url = new URL(this.settings!.redirect);
      url.searchParams.set('code', code);
      url.searchParams.set('state', state);
      const result = await client.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: verifier,
        expectedNonce: nonce,
        expectedState: state,
        maxAge: 300,
        idTokenExpected: true,
      });
      const claims = result.claims();
      if (
        !claims ||
        claims.iss !== this.settings!.issuer ||
        typeof claims.sub !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,255}$/u.test(claims.sub) ||
        typeof claims.auth_time !== 'number' ||
        !Number.isSafeInteger(claims.auth_time) ||
        claims.auth_time * 1000 > Date.now() + 30000 ||
        Date.now() - claims.auth_time * 1000 > 300000
      )
        throw new Error();
      return Object.freeze({
        issuer: claims.iss,
        subject: claims.sub,
        authenticatedAt: claims.auth_time * 1000,
      });
    } catch {
      throw new UnauthorizedException();
    }
  }
}
