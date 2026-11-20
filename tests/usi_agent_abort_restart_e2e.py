#!/usr/bin/env python3
"""Aborted games do not teach a draw; a fresh engine continues participation."""
import os,socket,subprocess,tempfile
from pathlib import Path
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='abort-restart-') as d:
 root=Path(d);engine=root/'engine';log=root/'commands';kif=root/'kif'
 engine.write_text('''#!/usr/bin/env python3
import os,sys
with open(sys.argv[1],'a',buffering=1) as log:
 print('pid '+str(os.getpid()),file=log,flush=True)
 for line in sys.stdin:
  line=line.strip();print(line,file=log,flush=True)
  if line=='usi':print('usiok',flush=True)
  elif line=='isready':print('readyok',flush=True)
  elif line.startswith('go '):print('info score cp 42 pv 7g7f 3c3d',flush=True);print('bestmove 7g7f',flush=True)
  elif line=='quit':break
''');engine.chmod(0o755)
 server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(15)
 p=subprocess.Popen([agent,'--engine',engine,'--host',f'127.0.0.1:{server.getsockname()[1]}','--name','Test','--pool','test','--games','2','--record-dir',kif,'--',log],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
 try:
  for index in range(2):
   conn,_=server.accept();conn.settimeout(10)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN ')
    summary=f'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:abort-{index}\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n'.encode();f.write(summary);assert f.readline()==b'AGREE\n';f.write(b'START:test\n');assert f.readline().startswith(b'+7776FU');f.write(b'+7776FU,T0\n');f.write(b'#ABNORMAL\n#CENSORED\n' if index==0 else b'#RESIGN\n#WIN\n')
  p.wait(timeout=12);assert p.returncode==0,p.stderr.read();commands=log.read_text().splitlines();pids=[x for x in commands if x.startswith('pid ')];assert len(pids)==2 and pids[0]!=pids[1],commands;assert commands.count('usi')==2 and 'gameover draw' not in commands and 'gameover win' in commands,commands
  csa=(kif/'abort-0.csa').read_text();assert "'#ABNORMAL" in csa and "'#CENSORED" in csa and "'summary:abnormal" not in csa,csa
 finally:
  server.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: censored abnormal game is not recorded or reported as a draw; engine restarts')
