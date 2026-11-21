#!/usr/bin/env python3
"""A stalled CSA file write must not delay starting the next search."""
import os,socket,subprocess,sys,tempfile,time
from pathlib import Path
if sys.platform!='linux':print('SKIP: Linux LD_PRELOAD test');raise SystemExit(0)
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT','target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='slow-record-') as d:
 root=Path(d);source=root/'slow.c';lib=root/'slow.so';engine=root/'engine'
 source.write_text('''#define _GNU_SOURCE
#include <unistd.h>
#include <sys/syscall.h>
#include <string.h>
#include <stdio.h>
#include <time.h>
ssize_t write(int fd,const void *buf,size_t n){char key[64],dest[4096];snprintf(key,sizeof(key),"/proc/self/fd/%d",fd);ssize_t len=syscall(SYS_readlink,key,dest,sizeof(dest)-1);if(len>0){dest[len]=0;if(strstr(dest,"/kif/")&&n>=7&&memcmp(buf,"-3334FU",7)==0){struct timespec t={3,0};nanosleep(&t,0);}}return syscall(SYS_write,fd,buf,n);}
''');subprocess.run(['cc','-shared','-fPIC','-o',str(lib),str(source)],check=True)
 engine.write_text('''#!/usr/bin/env python3
import sys
n=0
for l in sys.stdin:
 l=l.strip()
 if l=='usi':print('usiok',flush=True)
 elif l=='isready':print('readyok',flush=True)
 elif l.startswith('go '):n+=1;print('bestmove 7g7f' if n==1 else 'bestmove 2g2f',flush=True)
 elif l=='quit':break
''');engine.chmod(0o755)
 server=socket.socket();server.bind(('127.0.0.1',0));server.listen();server.settimeout(10)
 p=subprocess.Popen([str(agent),'--engine',str(engine),'--host',f'127.0.0.1:{server.getsockname()[1]}','--name','Test','--pool','test','--record-dir',str(root/'kif'),'--once'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,env={**os.environ,'LD_PRELOAD':str(lib)})
 try:
  conn,_=server.accept();conn.settimeout(10)
  with conn,conn.makefile('rwb',buffering=0) as f:
   assert f.readline().startswith(b'LOGIN ');f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:slow\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');assert f.readline()==b'AGREE\n';f.write(b'START:slow\n');assert f.readline().startswith(b'+7776FU');f.write(b'+7776FU,T0\n');started=time.monotonic();f.write(b'-3334FU,T0\n');assert f.readline().startswith(b'+2726FU');elapsed=time.monotonic()-started;assert elapsed<2,(elapsed,'record write stalled the next search');f.write(b'+2726FU,T0\n#RESIGN\n#WIN\n')
  p.wait(timeout=10);assert p.returncode==0,p.stderr.read()
 finally:
  server.close()
  if p.poll() is None:p.kill();p.wait()
print('PASS: slow CSA writes do not delay the next search')
