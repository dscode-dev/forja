import { Database, SqlExecutor } from '../database';
import { ProtectedKey, KeyIdentity, KeyState } from './contracts';
import { PlatformFailure } from '../failure';
import { positive, token, uuid } from './encoding';
export class UserKeyRepository {
  constructor(
    private readonly database: Database,
    private readonly environment: string,
  ) {}
  async insert(record: ProtectedKey): Promise<void> {
    uuid(record.binding.userId);
    uuid(record.binding.dekId);
    positive(record.binding.version);
    positive(record.kekVersion);
    token(record.provider);
    token(record.kekRef);
    if (
      record.binding.environment !== this.environment ||
      record.format !== 1 ||
      record.wrapped.length < 48 ||
      record.wrapped.length > 65536
    )
      throw new PlatformFailure('invalid');
    await this.database.query(
      `INSERT INTO app.user_data_keys(user_id,dek_id,dek_version,wrap_format,provider_id,kek_ref,kek_version,wrapped_dek,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
      [
        record.binding.userId,
        record.binding.dekId,
        record.binding.version,
        record.format,
        record.provider,
        record.kekRef,
        record.kekVersion,
        record.wrapped,
      ],
    );
  }
  async get(
    key: KeyIdentity,
    sql: SqlExecutor = this.database,
  ): Promise<ProtectedKey> {
    uuid(key.userId);
    uuid(key.dekId);
    positive(key.version);
    const result = await sql.query(
      'SELECT user_id,dek_id,dek_version,wrap_format,provider_id,kek_ref,kek_version,wrapped_dek FROM app.user_data_keys WHERE user_id=$1 AND dek_id=$2 AND dek_version=$3',
      [key.userId, key.dekId, key.version],
    );
    const row = result.rows[0];
    if (!row || row['wrap_format'] !== 1)
      throw new PlatformFailure('integrity');
    return {
      binding: {
        environment: this.environment,
        userId: row['user_id'] as string,
        dekId: row['dek_id'] as string,
        version: row['dek_version'] as number,
      },
      provider: row['provider_id'] as string,
      kekRef: row['kek_ref'] as string,
      kekVersion: row['kek_version'] as number,
      format: 1,
      wrapped: row['wrapped_dek'] as Buffer,
    };
  }
  async synchronizeState(key: KeyIdentity, state: KeyState): Promise<void> {
    await this.database.transaction(async (tx) => {
      if (state === 'active')
        await tx.query(
          "UPDATE app.user_data_keys SET state='decrypt-only' WHERE user_id=$1 AND state='active'",
          [key.userId],
        );
      const result = await tx.query(
        'UPDATE app.user_data_keys SET state=$1 WHERE user_id=$2 AND dek_id=$3 AND dek_version=$4',
        [state, key.userId, key.dekId, key.version],
      );
      if (result.rowCount !== 1) throw new PlatformFailure('integrity');
    });
  }
  async replace(record: ProtectedKey, expected: ProtectedKey): Promise<void> {
    const result = await this.database.query(
      'UPDATE app.user_data_keys SET wrapped_dek=$1,kek_ref=$2,kek_version=$3,provider_id=$4 WHERE user_id=$5 AND dek_id=$6 AND wrapped_dek=$7 AND kek_ref=$8 AND kek_version=$9 AND provider_id=$10',
      [
        record.wrapped,
        record.kekRef,
        record.kekVersion,
        record.provider,
        record.binding.userId,
        record.binding.dekId,
        expected.wrapped,
        expected.kekRef,
        expected.kekVersion,
        expected.provider,
      ],
    );
    if (result.rowCount !== 1) throw new PlatformFailure('conflict');
  }
}
