#!/usr/bin/env python3
"""Interrupted games restart the engine; opening move times affect its clock."""
import json, os, socket, subprocess, tempfile
from pathlib import Path
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='reconnect-opening-') as d:
 root=Path(d);engine=root/'engine';log=root/'commands'
 engine.write_text('''#!/usr/bin/env python3
import os,sys
with open(sys.argv[1],'a',buffering=1) as log:
 print('pid '+str(os.getpid()),file=log)
 for line in sys.stdin:
  line=line.strip();print(line,file=log)
  if line=='usi':print('usiok',flush=True)
  elif line=='isready':print('readyok',flush=True)
  elif line.startswith('go '):print('bestmove 2g2f',flush=True)
  elif line=='quit':break
''');engine.chmod(0o755)
 server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(15)
 p=subprocess.Popen([str(agent),'--engine',str(engine),'--host',f'127.0.0.1:{server.getsockname()[1]}','--name','Test','--pool','test','--',str(log)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 try:
  for i in range(2):
   conn,_=server.accept();conn.settimeout(10)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN ')
    f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:opening\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nIncrement:2\nBEGIN Position\nPI\n+\n+7776FU\nT25\n-3334FU\nT12\nEND Position\nEND Game_Summary\n')
    assert f.readline()==b'AGREE\n';f.write(b'START:test\n');assert f.readline().startswith(b'+2726FU');f.write(b'+2726FU,T0\n')
    if i==0:conn.shutdown(socket.SHUT_RDWR)
    else:p.stdin.write(b'q\n');p.stdin.flush();f.write(b'#RESIGN\n#WIN\n')
  p.wait(timeout=12);assert p.returncode==0,p.stderr.read()
  commands=log.read_text().splitlines();pids=[v for v in commands if v.startswith('pid ')]
  assert len(pids)==2 and pids[0]!=pids[1],commands
  assert commands.count('go btime 37000 wtime 50000 binc 2000 winc 2000')==2,commands
  assert commands.count('gameover win')==1 and 'gameover draw' not in commands,commands
 finally:
  server.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: engine restarts after disconnect; opening clocks include elapsed time and increment')
