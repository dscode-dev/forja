import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config/config';
import {
  readLocalCustody,
  localKeyRef,
} from './platform/crypto/local-provider';
import { LocalLifecycle } from './platform/crypto/local-lifecycle';
import { SafeLogger } from './platform/safe-logger';
try {
  const config = loadConfig();
  const custody = readLocalCustody(config.crypto.secretFile);
  const path = join(config.crypto.controlDirectory, 'lifecycle.sqlite');
  const initialize = !existsSync(path);
  if (initialize) {
    const permit = join(config.crypto.controlDirectory, 'bootstrap-permit');
    if (readFileSync(permit, 'utf8') !== custody.authorityId) throw new Error();
    unlinkSync(permit); // Burn bootstrap permission before first durable initialization.
  }
  const lifecycle = new LocalLifecycle(
    path,
    custody.authorityId,
    config.crypto.environmentId,
    true,
  );
  if (initialize)
    for (const key of custody.keys)
      lifecycle.registerWrapping(
        localKeyRef(config.crypto.environmentId, key.version),
      );
  for (const key of custody.keys)
    if (
      !lifecycle.wrappingKnown(
        localKeyRef(config.crypto.environmentId, key.version),
      )
    )
      throw new Error();
  lifecycle.close();
  new SafeLogger().event('application.started', 'success');
} catch {
  new SafeLogger().event('application.failed', 'unavailable');
  process.exitCode = 1;
}
