#!/usr/bin/env python3
"""CSA side-specific clocks and increments are not confused or silently approximated."""
import json,os,socket,subprocess,tempfile
from pathlib import Path
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='asymmetric-time-') as d:
 root=Path(d);engine=root/'engine';log=root/'commands'
 engine.write_text('''#!/usr/bin/env python3
import sys
n=0
with open(sys.argv[1],'a',buffering=1) as f:
 for line in sys.stdin:
  line=line.strip();print(line,file=f)
  if line=='usi':print('usiok',flush=True)
  elif line=='isready':print('readyok',flush=True)
  elif line.startswith('go '):
   n+=1;print('bestmove 7g7f' if n==1 else 'bestmove 2g2f',flush=True)
  elif line=='quit':break
''');engine.chmod(0o755)
 def case(fields, expected):
  log.unlink(missing_ok=True);server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
  p=subprocess.Popen([str(agent),'--engine',str(engine),'--host',f'127.0.0.1:{server.getsockname()[1]}','--name','Test','--pool','test','--once','--',str(log)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  try:
   conn,_=server.accept();conn.settimeout(10)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN ');f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:test\nName+:Test\nName-:Other\nYour_Turn:+\n'+fields+b'BEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n')
    response=f.readline()
    if expected:
     assert response==b'AGREE\n',response;f.write(b'START:test\n');assert f.readline().startswith(b'+7776FU');f.write(b'+7776FU,T10\n-3334FU,T20\n');assert f.readline().startswith(b'+2726FU');f.write(b'+2726FU,T0\n#RESIGN\n#WIN\n')
    else:assert response==b'',response
   p.wait(timeout=10);commands=log.read_text().splitlines()
   if expected:
    assert p.returncode==0 and expected in commands,(commands,p.stderr.read())
    if 'btime 60000 wtime 300000' in expected:assert 'go btime 51000 wtime 283000 binc 1000 winc 3000' in commands,commands
   else:assert p.returncode!=0 and '先後で異なる秒読み' in p.stderr.read().decode(),commands
  finally:
   server.close()
   if p.poll() is None:p.kill();p.wait()
 case(b'BEGIN Time+\nTotal_Time:60\nIncrement:1\nEND Time+\nBEGIN Time-\nTotal_Time:300\nIncrement:3\nEND Time-\n','go btime 60000 wtime 300000 binc 1000 winc 3000')
 case(b'BEGIN Time\nTotal_Time:120\nIncrement:2\nEND Time\nBEGIN Time-\nTotal_Time:300\nEND Time-\n','go btime 120000 wtime 300000 binc 2000 winc 2000')
 case(b'BEGIN Time+\nTotal_Time:60\nByoyomi:10\nEND Time+\nBEGIN Time-\nTotal_Time:300\nByoyomi:30\nEND Time-\n',None)
print('PASS: side-specific CSA clocks and increments; unequal byoyomi rejected')
