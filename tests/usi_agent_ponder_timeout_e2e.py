#!/usr/bin/env python3
"""Ponder stops have one deadline, including on terminal/disconnect paths."""
import concurrent.futures,os,socket,subprocess,tempfile,time,threading
from pathlib import Path
AGENT=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
def case(mode):
 with tempfile.TemporaryDirectory(prefix='ponder-timeout-') as d:
  root=Path(d);log=root/'commands';engine=root/'engine.py'
  engine.write_text('''#!/usr/bin/env python3
import sys
with open(sys.argv[1],'a',buffering=1) as log:
 for line in sys.stdin:
  line=line.strip();print(line,file=log,flush=True)
  if line=='usi':print('usiok',flush=True)
  elif line=='isready':print('readyok',flush=True)
  elif line.startswith('go ') and not line.startswith('go ponder'):print('bestmove 7g7f ponder 3c3d',flush=True)
  elif line=='quit':break
''');engine.chmod(0o755)
  server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
  p=subprocess.Popen([str(AGENT),'--engine',str(engine),'--host',f'127.0.0.1:{server.getsockname()[1]}','--name','Test','--pool','test','--ponder','--once','--',str(log)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
  def commands():return log.read_text().splitlines() if log.exists() else []
  def wait_for(fn):
   end=time.monotonic()+5
   while time.monotonic()<end:
    if fn():return
    time.sleep(.02)
   raise AssertionError((mode,commands()))
  try:
   conn,_=server.accept();conn.settimeout(10)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN ')
    f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:probe\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');assert f.readline()==b'AGREE\n';f.write(b'START:probe\n');assert f.readline().startswith(b'+7776FU');f.write(b'+7776FU,T0\n')
    wait_for(lambda:any(x.startswith('go ponder ') for x in commands()))
    start=time.monotonic()
    if mode=='terminal':f.write(b'#RESIGN\n#LOSE\n')
    else:
     f.write(b'-8384FU,T0\n');wait_for(lambda:'stop' in commands())
     if mode=='miss_flood':
      def flood():
       while p.poll() is None:
        try:conn.sendall(b'\n'*128)
        except OSError:break
        time.sleep(.001)
      threading.Thread(target=flood,daemon=True).start()
     if mode=='miss_terminal':time.sleep(4);f.write(b'#RESIGN\n#LOSE\n')
     if mode=='miss_disconnect':time.sleep(4);conn.shutdown(socket.SHUT_RDWR)
    p.wait(timeout=14);elapsed=time.monotonic()-start;error=p.stderr.read();assert p.returncode!=0,(mode,error);assert 9<=elapsed<13,(mode,elapsed,error);assert commands().count('stop')==1,(mode,commands());assert '10秒以内' in error,(mode,error)
  finally:
   server.close()
   if p.poll() is None:p.kill();p.wait()
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
 list(pool.map(case,['miss','terminal','miss_terminal','miss_disconnect','miss_flood']))
print('PASS: missing ponder stop responses time out once within the original deadline')
