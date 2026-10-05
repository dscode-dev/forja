# Development foundation

Canonical development tooling/workflow. Persistence contracts: [persistence](persistence.md). Runtime/module rules stay in [architecture](architecture.md), sensitive handling in [security](security.md), mobile handoff in [mobile development](mobile-development.md). Identity/authentication and encrypted minimal profiles are implemented; no financial/game/AI schema exists. Production gates remain explicit.

## Repository ownership

`apps/api`: NestJS platform/Identity modules, health and tests. `apps/mobile`: directly openable Unity project. `infra`: local Compose and role bootstrap. `scripts`: small developer entrypoints/static validation. `docs/contracts`: cross-runtime wire contracts. `.vscode`: editor recommendations. No Nx/Turborepo/shared business library; use npm only in apps/api.

## Pinned tools

| Tool | Version / authority |
| --- | --- |
| Node | 24.21.0 LTS; Docker image pinned by digest, .nvmrc for optional host tools; host Node 25 is not the authoritative build runtime |
| npm | 11.18.0; tooling image, packageManager and engines; lockfile installs via npm ci |
| NestJS | 11.2.7; deliberately tested stable baseline rather than migrating to the newer major during bootstrap |
| TypeScript | 5.9.3, strict NodeNext resolution; package defaults to CommonJS, compatible with Node 24's ESM dependency loading |
| PostgreSQL | 18.6 bookworm; image pinned by digest; [official supported version policy](https://www.postgresql.org/support/versioning/) |
| Persistence/migrations | node-postgres 8.23.1 + node-pg-migrate 9.0.0; explicit SQL/transaction control without ORM schema synchronization; [migration tool documentation](https://salsita.github.io/node-pg-migrate/) |
| Authentication | openid-client 6.8.8, exact lockfile; native Node cryptography, no password/JWT signing implementation |
| Test TLS | OpenSSL CLI 3.0.22-1~deb12u1 pinned in the development image, only for ephemeral HTTPS OIDC test certificates; Node native OpenSSL remains separate |
| Checks | Node built-in test runner + Nest testing utilities, ESLint 10.12.0, typescript-eslint 8.71.0, Prettier 3.9.9; exact lockfile |
| Unity | 6000.6.4f1 Supported, revision 12bfff696524; [official release](https://unity.com/releases/editor/whats-new/6000.6.4f1); installed Editor compiled/tested the project and generated iOS; signed device launch/lifecycle validated; performance measurement pending |

Docker Desktop/Compose and Python 3 are prerequisites. Xcode 16.2 compiled the unsigned iOS output on macOS 15.8.1 and listed the paired iPhone as a destination; signed installation, launch and relaunch succeeded on its iOS 27.0.1. Unity Editor policy is recorded in [ADR 0010](adr/0010-unity-supported-editor.md); the native import resolved test-framework 1.8.0, tracked by manifest/lock and static checks. Versions are deliberate baselines, not automatic updates; review dependency/security changes with lockfile/image/editor checks.

## Commands — repository root

```sh
scripts/dev setup        # non-secret .env settings + generated local password files; preserves passwords
scripts/dev crypto-open  # Keychain -> private runtime delivery; first use grants one-time control bootstrap
scripts/dev install      # locked dependencies in Node container
scripts/dev crypto-bootstrap # explicit independent control schema initialization/migrations
scripts/dev up           # healthy isolated PostgreSQL
scripts/dev migrate      # explicit migration role; wrapped-key platform schema only
scripts/dev run          # build/watch API on http://127.0.0.1:3010
scripts/dev check        # build, lint, format-check, types, unit tests, static mobile structure
scripts/dev integration  # real PostgreSQL/HTTP/migration tests in forja_test
scripts/dev config       # Compose validation without printing environment
scripts/dev logs         # safe API events
scripts/dev down         # stops Forja services, preserves volumes
scripts/dev clean --confirm # explicitly destroys only Forja development volumes
```

For individual checks: `docker compose --env-file .env --file infra/compose.yaml run --rm tools npm run lint` (substitute `build`, `typecheck`, `test`, `format:check`, `test:integration`). Rebuild TypeScript through `build` after edits; the API watches compiled files, so `dev` does not compile TypeScript automatically. `format` intentionally writes formatting; checks never auto-fix source.

Compose binds only the API to host loopback (3010 by default, configurable through FORJA_API_PORT); PostgreSQL has no host port. It is an isolated local development stack, not production deployment. `LOCAL_UID/GID` are generated for the workstation, letting containers write bind-mounted source/output as the developer. The dependency volume disables image copy-up, preserving initialized UID ownership even when empty. Install initializes only that volume using container root, then runs all application/tool work as the developer UID. PostgreSQL's root startup copies mounted passwords to postgres-owned tmpfs before handing off to the official non-root entrypoint; host files remain 0600 in a 0700 directory.

## Configuration and security

.env contains settings/file references only; generated password files live under ignored .local/secrets. Never print these files, Docker environment dumps or full exceptions for diagnosis. PostgreSQL initialization creates real development credentials/roles and empty databases, not fictitious users/financial histories. API role has no schema CREATE or migration-bookkeeping access; migration role owns app schema. Future domain migrations grant only their required runtime privileges explicitly. Test database is separate; migration fixtures are defined only inside tests and removed afterward.

Initialization runs only for a new volume. Changing secret files without updating DB roles causes authentication failure; setup deliberately preserves them. Reset is explicit/destructive via clean --confirm, never automatic. API/tools bind only apps/api, never the root .local secret directory; the running API mounts only its own password, not migrator/admin credentials. Database statement/parameter error logging is disabled. No Redis/pgvector/KMS emulator is used; only the explicitly development-only Keychain custody is delivered through the private runtime mount. PR-02 implements independent development lifecycle/local Keychain wrapping and wrapped-key persistence. Production managed adapters and their operational evidence remain mandatory before sensitive production use; see [persistence](persistence.md). Production refuses plaintext DB credentials/URLs, raw KEK/DEK env variables and unverified DB TLS; production ingress TLS and workload/key infrastructure are deployment prerequisites.

Health contract: [shared contracts](contracts/README.md). Framework/request/error messages are discarded; only typed allowlisted platform events are logged. Client errors never include exception strings, SQL or request data. Safe tests target failure paths, not generic framework behavior. No logging/telemetry SDK or body recorder is installed.

## CI entrypoint

On a macOS runner with authorized Keychain custody, use `scripts/dev setup`, `crypto-open`, `install`, `crypto-bootstrap`, `up`, `migrate`, `check`, `integration`, `down`. A Linux hosted runner requires a separately scoped test-only custody bootstrap or verified managed adapters; do not invent production custody to attach CI. No hosted provider/repository exists yet, so PR-01 does not fabricate a connected CI service. Attach this sequence when repository hosting is selected; secrets are generated inside that isolated run. Unity import/device gates remain separate and cannot be replaced by static CI checks.

## Crypto configuration

CRYPTO_PROVIDER=local-development, CRYPTO_ENVIRONMENT_ID and absolute CRYPTO_SECRET_FILE/CRYPTO_CONTROL_DIRECTORY references are non-secret settings. scripts/dev crypto-open updates these references without printing key values. Run setup → crypto-open → install → crypto-bootstrap → up → migrate before run. Existing custody without control continuity fails closed. crypto-close stops API and removes delivery; down also removes delivery while preserving counters/PG volumes. Reopen through Keychain before restarting.

Production NODE_ENV rejects this provider even with verified DB TLS. No raw KEK/DEK config is supported. Migrator configuration is DB-only and preserves strict TLS/secret-file rules. [Persistence](persistence.md) owns scope, recovery and adapter/deployment gates.

## Identity configuration and upgrade

For an existing PR-02 environment, rebuild tooling/API (`docker compose --env-file .env --file infra/compose.yaml build tools api`), run install, crypto-bootstrap, migrate, then run. Control schema 3 adds independent authentication metadata without resetting counters. Never delete the control store to fix a migration error. The migration adds real identity/profile/audit tables and ownership constraints; no accounts or profiles are seeded.

OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_REDIRECT_URI in local .env are public operator-approved enrollment settings. Configure all three together; issuer/endpoints must use verified HTTPS, the public client must support RS256, S256 PKCE, opaque non-email subjects, auth_time/max_age and the exact callback. No client secret is accepted/needed. Until enrollment exists, auth returns unavailable while operational health still validates platform dependencies. [Identity](identity.md) owns behavior; [wire contracts](contracts/identity.md) own mobile payloads.

The existing integration command now generates ephemeral TLS/signing fixtures solely inside tests and exercises the real OIDC client and PostgreSQL. Test CA trust is limited to that test subprocess; no runtime insecure TLS option or seeded test provider exists. Safe audit retention cleanup runs on audited operations; idle deployments require an approved scheduled retention operation before production.
