import { SqlExecutor } from './database';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CONFIG, RuntimeConfig } from '../config/config';
import { CryptoPlatform } from './crypto/crypto-platform';
import { KeyScope } from './crypto/key-service';
import { PayloadContext } from './crypto/envelope';
import { SessionPrincipal } from './auth-control';
import { PlatformFailure } from './failure';
export interface EncryptedRow extends Record<string, unknown> {
  user_id: string;
  revision: number;
  dek_id: string;
  dek_version: number;
  payload: string;
}
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function envelopeHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
// Purpose-specific caller supplies server-selected record identity and classified metadata.
@Injectable()
export class EncryptedRecord {
  constructor(
    private readonly crypto: CryptoPlatform,
    @Inject(CONFIG) private readonly config: RuntimeConfig,
  ) {}
  private context(
    row: Omit<EncryptedRow, 'payload'>,
    kind: string,
    entity: string,
    metadata: (string | number | null)[],
  ): PayloadContext {
    return {
      environment: this.config.crypto.environmentId,
      userId: row.user_id as string,
      entityKind: kind,
      entityId: entity,
      slot: 'private',
      revision: row.revision as number,
      metadataSchema: 1,
      metadata,
      dekId: row.dek_id as string,
      dekVersion: row.dek_version as number,
      payloadSchema: 1,
    };
  }
  async seal(
    scope: KeyScope,
    kind: string,
    entity: string,
    revision: number,
    metadata: (string | number | null)[],
    value: unknown,
  ): Promise<string> {
    const buffer = Buffer.from(JSON.stringify({ schema: 1, value }));
    try {
      return await scope.encrypt(
        buffer,
        this.context(
          {
            user_id: scope.identity.userId,
            dek_id: scope.identity.dekId,
            dek_version: scope.identity.version,
            revision,
          },
          kind,
          entity,
          metadata,
        ),
      );
    } finally {
      buffer.fill(0);
    }
  }
  async open<T>(
    principal: SessionPrincipal,
    row: EncryptedRow,
    kind: string,
    entity: string,
    metadata: (string | number | null)[],
    validate: (value: unknown) => T,
    sql?: SqlExecutor,
  ): Promise<T> {
    if (row.user_id !== principal.userId) throw new PlatformFailure('fenced');
    return this.crypto.keys.withKey(
      { userId: principal.userId, dekId: row.dek_id, version: row.dek_version },
      principal.binding,
      'decrypt',
      async (scope) => {
        let buffer: Buffer;
        try {
          buffer = await scope.decrypt(
            row.payload,
            this.context(row, kind, entity, metadata),
          );
        } catch (error) {
          if (error instanceof PlatformFailure && error.code === 'invalid')
            throw new PlatformFailure('integrity');
          throw error;
        }
        try {
          const decoded = JSON.parse(buffer.toString('utf8')) as {
            schema: unknown;
            value: unknown;
          };
          if (
            !decoded ||
            Object.keys(decoded).sort().join(',') !== 'schema,value' ||
            decoded.schema !== 1
          )
            throw new Error();
          return validate(decoded.value);
        } catch {
          throw new PlatformFailure('integrity');
        }
      },
      sql,
    );
  }
}
