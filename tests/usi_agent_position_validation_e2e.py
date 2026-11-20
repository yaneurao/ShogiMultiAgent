#!/usr/bin/env python3
"""Reject incomplete board rows while accepting CSA board representations."""
import os,socket,subprocess,tempfile
from pathlib import Path
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='position-validation-') as d:
 e=Path(d)/'engine';e.write_text("#!/usr/bin/env python3\nimport sys\nfor l in sys.stdin:\n if l.strip()=='usi':print('usiok',flush=True)\n elif l.strip()=='isready':print('readyok',flush=True)\n elif l.startswith('go '):print('bestmove resign',flush=True)\n elif l.strip()=='quit':break\n");e.chmod(0o755)
 rows=b'P1-KY-KE-GI-KI-OU-KI-GI-KE-KY\nP2 * -HI *  *  *  *  * -KA * \nP3-FU-FU-FU-FU-FU-FU-FU-FU-FU\nP4 *  *  *  *  *  *  *  *  * \nP5 *  *  *  *  *  *  *  *  * \nP6 *  *  *  *  *  *  *  *  * \nP7+FU+FU+FU+FU+FU+FU+FU+FU+FU\nP8 * +KA *  *  *  *  * +HI * \nP9+KY+KE+GI+KI+OU+KI+GI+KE+KY\n+\n'
 for position,valid in [(b'PI\n+\n',True),(b'PI82HI22KA\n+\n',True),(rows,True),(b'P+59OU\nP-51OU\n+\n',True),(b'P1-KY-KE-GI-KI-OU-KI-GI-KE-KY\n+\n',False),(rows+b'P1-KY-KE-GI-KI-OU-KI-GI-KE-KY\n',False),(b'PI51OU\n+\n',False)]:
  server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10);p=subprocess.Popen([str(agent),'--engine',str(e),'--host',f'127.0.0.1:{server.getsockname()[1]}','--name','Test','--pool','test','--once'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  try:
   conn,_=server.accept();conn.settimeout(10)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN ');f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:board\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\n'+position+b'END Position\nEND Game_Summary\n');response=f.readline()
    if valid:assert response==b'AGREE\n',(position,response);f.write(b'START:board\n');assert f.readline()==b'%TORYO\n';f.write(b'#RESIGN\n#LOSE\n')
    else:assert response==b'',(position,response)
   p.wait(timeout=10);assert (p.returncode==0)==valid,(position,p.stderr.read())
  finally:
   server.close()
   if p.poll() is None:p.kill();p.wait()
print('PASS: complete CSA boards accepted; missing, duplicate and kingless boards rejected')
