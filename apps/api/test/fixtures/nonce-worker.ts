import { LocalLifecycle } from '../../src/platform/crypto/local-lifecycle';
import { KeyIdentity } from '../../src/platform/crypto/contracts';
const [path, authority, identityString, digest, fingerprint] =
  process.argv.slice(2) as [string, string, string, string, string];
const store = new LocalLifecycle(path, authority, 'forja-test');
const lease = store.admit(
  JSON.parse(identityString) as KeyIdentity,
  digest,
  fingerprint,
  'encrypt',
);
try {
  console.log(
    JSON.stringify(
      Array.from({ length: 50 }, () => store.reserve(lease).toString('hex')),
    ),
  );
} finally {
  store.release(lease);
  store.close();
}
