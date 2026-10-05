import { EncryptedRecord } from './encrypted-record';
import { PrivacyErasure } from './privacy-erasure';
import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from '../config/config';
import { Database } from './database';
import { CryptoPlatform } from './crypto/crypto-platform';
import { SafeLogger } from './safe-logger';
import { join } from 'node:path';
import { RuntimeConfig } from '../config/config';
import { AUTH_CONTROL, LocalAuthControl } from './auth-control';
import { readLocalCustody } from './crypto/local-provider';
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    Database,
    PrivacyErasure,
    EncryptedRecord,
    CryptoPlatform,
    {
      provide: AUTH_CONTROL,
      inject: [CONFIG],
      useFactory: (config: RuntimeConfig) =>
        new LocalAuthControl(
          join(config.crypto.controlDirectory, 'lifecycle.sqlite'),
          readLocalCustody(config.crypto.secretFile).authorityId,
          config.crypto.environmentId,
        ),
    },
    { provide: SafeLogger, useFactory: () => new SafeLogger() },
  ],
  exports: [
    PrivacyErasure,
    EncryptedRecord,
    CONFIG,
    Database,
    CryptoPlatform,
    SafeLogger,
    AUTH_CONTROL,
  ],
})
export class PlatformModule {}
