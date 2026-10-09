"""Private Container entry. Fixed synthetic snapshot -> existing exporter/dbt -> artifacts."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

APP = Path(__file__).resolve().parents[1]
ANALYTICS = APP.parents[1] / 'analytics-poc'
MAX_INPUT = 8 * 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024

def build(request):
    registration = os.environ.get('CLOUD_ANALYTICS_REGISTRATION_ID')
    definition = os.environ.get('CLOUD_ANALYTICS_DEFINITION_VERSION')
    if not registration or not definition:
        raise ValueError('Dedicated synthetic registration and definition are required')
    if request.get('registrationId') != registration or request.get('definitionVersion') != definition or request.get('orgId') != 1:
        raise ValueError('Snapshot environment does not match')
    if request.get('source') != 'registered-synthetic-workbench' or request.get('formatVersion') != 1:
        raise ValueError('Only registered synthetic snapshots are supported')
    encoded = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) > MAX_INPUT:
        raise ValueError('Snapshot exceeds 8MB; partial processing is prohibited')
    sys.path.insert(0, str(ANALYTICS))
    from run_workbench_snapshot import build as build_dbt, verify_run
    with tempfile.TemporaryDirectory(prefix='workbench-cloud-analytics-') as temporary:
        root = Path(temporary)
        incoming = root / 'frozen.json'
        incoming.write_bytes(encoded)
        run = root / 'run'
        proc = subprocess.run([os.environ.get('CLOUD_ANALYTICS_NODE', 'node'), str(APP / 'scripts/cloud-snapshot-materialize.mjs'), str(incoming), str(run)], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=40)
        if proc.returncode:
            raise ValueError('Snapshot materialization failed: ' + proc.stderr[-1500:])
        try:
            build_dbt(run)
        except Exception as error:
            log = run / 'build.log'
            detail = log.read_text(encoding='utf-8', errors='replace')[-3000:] if log.exists() else str(error)
            raise ValueError('Cloud analysis failed: ' + detail) from error
        # Portable object keys, including when tests execute on Windows.
        verification_path = run / 'verification.json'
        portable = json.loads(verification_path.read_text(encoding='utf-8'))
        portable['files'] = {name.replace('\\', '/'): value for name, value in portable['files'].items()}
        verification_path.write_text(json.dumps(portable, ensure_ascii=False, indent=2), encoding='utf-8')
        verification = verify_run(run)
        files = []
        paths = sorted(set(verification['files']) | {'verification.json'})
        total = 0
        for relative in paths:
            path = (run / relative).resolve()
            if not path.is_relative_to(run.resolve()):
                raise ValueError('Artifact path is invalid')
            data = path.read_bytes()
            total += 4 * ((len(data) + 2) // 3) + len(relative) + 160
            if total > MAX_RESPONSE - 1024:
                raise ValueError('Artifacts exceed 16MB; active analysis must be retained')
            files.append({'path': relative.replace('\\', '/'), 'sha256': hashlib.sha256(data).hexdigest(), 'base64': base64.b64encode(data).decode('ascii')})
        result = {'ok': True, 'files': files}
        if len(json.dumps(result).encode('utf-8')) > MAX_RESPONSE:
            raise ValueError('Artifacts exceed response limit')
        return result

if __name__ == '__main__':
    try:
        json.dump(build(json.load(sys.stdin)), sys.stdout, ensure_ascii=False)
    except Exception as error:
        json.dump({'ok': False, 'error': str(error)}, sys.stdout, ensure_ascii=False)
        sys.exit(1)
