#!/usr/bin/env python3
"""An invalid login is terminal and reported, rather than retried forever."""
import json, os, socket, subprocess, tempfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
agent = Path(os.environ.get('SHOGIZONE_USI_AGENT', root / 'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory() as d:
    engine = Path(d, 'engine.py')
    engine.write_text("#!/usr/bin/env python3\nimport sys\nfor l in sys.stdin:\n if l.strip()=='usi':print('usiok',flush=True)\n elif l.strip()=='isready':print('readyok',flush=True)\n")
    engine.chmod(0o755)
    server = socket.socket(); server.bind(('127.0.0.1', 0)); server.listen(); server.settimeout(15)
    p = subprocess.Popen([agent, '--app-mode'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{server.getsockname()[1]}','name':'Test','trip':'secret','pool':'floodgate-300-10F'})+'\n'); p.stdin.flush()
        c,_=server.accept()
        with c, c.makefile('rwb', buffering=0) as f:
            assert f.readline().startswith(b'LOGIN Test '); f.write(b'LOGIN:incorrect\n')
        p.wait(timeout=10)
        out,err=p.communicate(timeout=10)
        events=[json.loads(line) for line in out.splitlines()]
        assert p.returncode != 0 and any(e.get('event')=='error' and 'ログインを拒否' in e.get('message','') for e in events),(out,err)
        assert 'secret' not in out+err
    finally:
        server.close()
        if p.poll() is None: p.kill(); p.wait()
print('PASS: rejected login stops with an actionable error')
