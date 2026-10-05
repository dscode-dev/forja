#!/usr/bin/env python3
"""Local-only Keychain custody. Never prints keychain values or places them in argv/env."""
from pathlib import Path
import json, os, secrets, subprocess, sys, uuid
root = Path(__file__).resolve().parent.parent
runtime = root / '.local/runtime'
control = root / '.local/control'
secret = runtime / 'development-data-key'
service = 'forja.development.user-data.v1'
try:
    if sys.argv[1] == 'close':
        secret.unlink(missing_ok=True)
        print('Private runtime key delivery removed; Keychain custody retained.')
        sys.exit(0)
    assert sys.argv[1] == 'open' and sys.platform == 'darwin'
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    control.mkdir(parents=True, exist_ok=True, mode=0o700)
    runtime.chmod(0o700); control.chmod(0o700)
    lookup = subprocess.run(['security', 'find-generic-password', '-s', service, '-a', 'forja', '-w'], capture_output=True)
    new_custody = lookup.returncode == 44
    if new_custody:
        # Never create new custody if existing control data could belong to lost keys.
        assert not (control / 'lifecycle.sqlite').exists()
        value = json.dumps({'authorityId': str(uuid.uuid4()), 'activeVersion': 1, 'keys': [{'version': 1, 'key': secrets.token_bytes(32).hex()}]}, separators=(',', ':'))
        data = json.loads(value)
        import base64
        data['keys'][0]['key'] = base64.b64encode(bytes.fromhex(data['keys'][0]['key'])).decode()
        value = json.dumps(data, separators=(',', ':'))
        # security interactive mode reads the command from stdin, not a secret-bearing process argument.
        created = subprocess.run(['security', '-i'], input=("add-generic-password -a forja -s " + service + " -w '" + value + "'\n").encode(), capture_output=True)
        assert created.returncode == 0
        lookup = subprocess.run(['security', 'find-generic-password', '-s', service, '-a', 'forja', '-w'], capture_output=True)
    assert lookup.returncode == 0
    custody = json.loads(lookup.stdout)
    # Only freshly generated custody permits first bootstrap. Existing custody requires existing counters.
    if not new_custody: assert (control / 'lifecycle.sqlite').exists()
    if new_custody:
        permit = control / 'bootstrap-permit'
        with permit.open('x') as stream: stream.write(custody['authorityId'])
        permit.chmod(0o600)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    fd = os.open(secret, flags, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(json.dumps(custody, separators=(',', ':')).encode()); stream.flush(); os.fsync(stream.fileno())
    secret.chmod(0o600)
    settings = root / '.env'
    values = {'CRYPTO_PROVIDER': 'local-development', 'CRYPTO_ENVIRONMENT_ID': 'forja-development', 'CRYPTO_SECRET_FILE': '/run/secrets/development-data-key', 'CRYPTO_CONTROL_DIRECTORY': '/run/forja-control'}
    import re
    current = settings.read_text()
    for key, value in values.items():
        current = re.sub(rf'^{key}=.*\n?', '', current, flags=re.M) + f'{key}={value}\n'
    settings.write_text(current); settings.chmod(0o600)
    print('Development custody delivered from macOS Keychain; no key value printed.')
except Exception:
    print('Development custody unavailable; inspect Keychain access and local control continuity without printing secrets.', file=sys.stderr)
    sys.exit(1)
