#!/usr/bin/env python3
"""Static authored-project checks. This never claims Unity compilation/runtime PASS."""
from pathlib import Path
import json
import re

root = Path(__file__).resolve().parent.parent / 'apps/mobile'
for folder in ('Assets', 'Packages', 'ProjectSettings'):
    assert (root / folder).is_dir(), folder
version = (root / 'ProjectSettings/ProjectVersion.txt').read_text()
assert '6000.6.4f1' in version and '12bfff696524' in version
manifest = json.loads((root / 'Packages/manifest.json').read_text())
assert manifest['dependencies']['com.unity.test-framework'] == '1.8.0'
assemblies = {}
for p in (root / 'Assets').rglob('*.asmdef'):
    value = json.loads(p.read_text())
    assert value['name'] not in assemblies
    assemblies[value['name']] = value
for name in ('Forja.Core', 'Forja.Application'):
    assert assemblies[name]['noEngineReferences'] is True
    for p in (root / f'Assets/Forja/{name.split(".")[1]}').glob('*.cs'):
        assert 'using UnityEngine' not in p.read_text()
stack, done = set(), set()
def visit(name):
    assert name not in stack, f'Assembly cycle: {name}'
    if name in done: return
    stack.add(name)
    for dependency in assemblies[name]['references']:
        assert dependency in assemblies, dependency
        visit(dependency)
    stack.remove(name)
    done.add(name)
for name in assemblies: visit(name)
guids = {}
for p in (root / 'Assets').rglob('*'):
    if p.suffix == '.meta': continue
    meta = Path(str(p) + '.meta')
    assert meta.is_file(), f'Missing .meta: {p}'
    match = re.search(r'^guid: ([0-9a-f]{32})$', meta.read_text(), re.M)
    assert match, meta
    guid = match.group(1)
    assert guid not in guids, f'Duplicate GUID: {meta}'
    guids[guid] = p
scene = root / 'Assets/Forja/Scenes/Bootstrap.unity'
for guid in re.findall(r'guid: ([0-9a-f]{32})', scene.read_text()):
    assert guid in guids
assert 'Main Camera' in scene.read_text()
settings = (root / 'ProjectSettings/EditorBuildSettings.asset').read_text()
assert 'Assets/Forja/Scenes/Bootstrap.unity' in settings
assert next(g for g, p in guids.items() if p == scene) in settings
player = (root / 'ProjectSettings/ProjectSettings.asset').read_text()
assert 'appleEnableAutomaticSigning: 0' in player
assert '    iPhone: com.darlan.forja.dev' in player
assert 'insecureHttpOption: 0' in player
print(f'PASS static Unity structure: {len(assemblies)} assemblies; {len(guids)} unique asset GUIDs; scene/build references; version and security settings')
print('STATIC ONLY: this command does not establish native compilation/tests/build/device success; executed gate evidence is recorded in docs/prs/PR-01.md')
