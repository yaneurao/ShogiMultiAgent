#!/usr/bin/env python3
"""Machine protocol transmits trip only on stdin and reports a real game."""
import json,os,socket,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT',ROOT/'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory(prefix='agent-app-') as d:
 e=Path(d,'engine.py');e.write_text('''#!/usr/bin/env python3
import sys
for line in sys.stdin:
 line=line.strip()
 if line=='usi': print('usiok',flush=True)
 elif line=='isready': print('readyok',flush=True)
 elif line.startswith('go '): print('info score cp 123 pv 7g7f 3c3d',flush=True);print('bestmove 7g7f',flush=True)
 elif line=='quit': break
''');e.chmod(0o755)
 for mode in ['q','eof','max','resign','sennichite','stripped','plain_draw']:
  s=socket.socket();s.bind(('127.0.0.1',0));s.listen();s.settimeout(20)
  p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   p.stdin.write(json.dumps(dict(engine=str(e),host='127.0.0.1:'+str(s.getsockname()[1]),name='Test',pool='floodgate-300-10F',trip='private-secret',record_dir=str(Path(d,'kif')),options=[]))+'\n');p.stdin.flush()
   c,_=s.accept();c.settimeout(20)
   with c,c.makefile('rwb',buffering=0) as f:
    assert f.readline()==b'LOGIN Test floodgate-300-10F,private-secret\n'
    f.write(b'LOGIN:Test OK\nBEGIN Game_Summary\nGame_ID:test+20261118000000\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nIncrement:2\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n');assert f.readline()==b'AGREE\n';f.write(b'START:test\n');assert f.readline().startswith(b'+7776FU,');f.write(b"+7776FU,T0\n" if mode=='stripped' else b"+7776FU,T0,'* 123 +7776FU -3334FU\n");(p.stdin.write('q\n'),p.stdin.flush()) if mode!='eof' else (p.stdin.close(),setattr(p,'stdin',None));time.sleep(.2);f.write({'max':b'#MAX_MOVES\n#CENSORED\n','resign':b'#RESIGN\n#WIN\n','sennichite':b'#SENNICHITE\n#DRAW\n','plain_draw':b'#DRAW\n'}.get(mode,b'%TORYO,T1\n#WIN\n'));assert f.readline()==b'LOGOUT\n'
   out,err=p.communicate(timeout=20);events=[json.loads(line) for line in out.splitlines()];types=[e['event'] for e in events]
   assert p.returncode==0,(out,err);assert 'private-secret' not in out+err
   for name in ['state','game_started','analysis','move','game_finished','record','exited']:assert name in types,events
   assert any(e.get('state')=='waiting' for e in events);assert next(e for e in events if e['event']=='analysis')['score']=='123';assert next(e for e in events if e['event']=='move')['ply']==1
   start=next(e for e in events if e['event']=='game_started');move=next(e for e in events if e['event']=='move');assert start['frames'][0]['ply']==0 and start['black']=='Test';assert move['clocks']==[62,60] and move['pv']==([] if mode=='stripped' else ['7g7f','3c3d']);assert next(e for e in events if e['event']=='analysis')['evaluation']==123
   record=Path(next(e for e in events if e['event']=='record')['path']);assert record.exists()
   csa=record.read_text()
   assert csa.count("'** 123 +7776FU -3334FU")==1,csa
   if mode=='resign': assert '%TORYO\n' in csa and "'summary:toryo:Test win:Other lose" in csa,csa
   if mode=='plain_draw': assert csa.count('%HIKIWAKE\n')==1 and "'summary:" not in csa,csa
   if mode=='sennichite': assert '%SENNICHITE\n' in csa and "'summary:sennichite:Test draw:Other draw" in csa,csa
   if mode=='max': assert "'summary:max_moves:Test draw:Other draw" in csa,csa
   if mode in ('q','eof'): assert csa.count('%TORYO')==1,csa
   if mode=='max':
    finished=next(e for e in events if e['event']=='game_finished');assert finished['result']=='#CENSORED' and finished['reason']=='#MAX_MOVES',finished
  finally:
   s.close()
   if p.poll() is None:p.kill();p.wait()
print('PASS: structured events, secret stdin, real game, safe stop and CSA record')
