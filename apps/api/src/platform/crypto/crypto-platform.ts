import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { join } from 'node:path';
import { CONFIG, RuntimeConfig } from '../../config/config';
import { Database } from '../database';
import { LocalLifecycle } from './local-lifecycle';
import { LocalKeyProvider, readLocalCustody } from './local-provider';
import { UserKeyRepository } from './key-repository';
import { UserKeyService } from './key-service';
@Injectable()
export class CryptoPlatform implements OnApplicationShutdown {
  readonly lifecycle: LocalLifecycle;
  readonly provider: LocalKeyProvider;
  readonly keys: UserKeyService;
  constructor(
    @Inject(CONFIG) config: RuntimeConfig,
    private readonly database: Database,
  ) {
    const custody = readLocalCustody(config.crypto.secretFile);
    this.lifecycle = new LocalLifecycle(
      join(config.crypto.controlDirectory, 'lifecycle.sqlite'),
      custody.authorityId,
      config.crypto.environmentId,
    );
    this.provider = new LocalKeyProvider(
      config.environment,
      config.crypto.environmentId,
      custody,
      this.lifecycle,
    );
    const repository = new UserKeyRepository(
      database,
      config.crypto.environmentId,
    );
    this.keys = new UserKeyService(
      config.crypto.environmentId,
      this.provider,
      this.lifecycle,
      repository,
      database,
    );
  }
  async ready(): Promise<boolean> {
    try {
      await this.database.query(
        'SELECT dek_id FROM app.user_data_keys LIMIT 0',
      );
      return this.lifecycle.ready() && (await this.provider.ready());
    } catch {
      return false;
    }
  }
  async onApplicationShutdown(): Promise<void> {
    await this.keys.drain();
    this.provider.close();
    this.lifecycle.close();
  }
}
