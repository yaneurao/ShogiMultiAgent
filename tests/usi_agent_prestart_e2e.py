#!/usr/bin/env python3
"""A rejected or incomplete CSA summary must never be counted as a game."""
import json, os, socket, subprocess, tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
agent=Path(os.environ.get('SHOGIZONE_USI_AGENT',root/'target/debug/shogizone-participant-agent')).resolve()
with tempfile.TemporaryDirectory() as d:
 engine=Path(d,'engine.py');engine.write_text("#!/usr/bin/env python3\nimport sys\nfor l in sys.stdin:\n if l.strip()=='usi':print('usiok',flush=True)\n elif l.strip()=='isready':print('readyok',flush=True)\n elif l.strip()=='quit':break\n");engine.chmod(0o755)
 for mode in ['reject','abnormal','missing','bad_side','no_begin','early_move','empty_position','partial_position','no_king']:
  listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(15)
  p=subprocess.Popen([agent,'--app-mode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   p.stdin.write(json.dumps({'engine':str(engine),'host':f'127.0.0.1:{listener.getsockname()[1]}','name':'Test'})+'\n');p.stdin.flush()
   conn,_=listener.accept();conn.settimeout(15)
   with conn,conn.makefile('rwb',buffering=0) as f:
    assert f.readline().startswith(b'LOGIN Test ')
    turn=b'?' if mode=='bad_side' else b'+'
    position=b'' if mode=='missing' else b'BEGIN Position\nEND Position\n' if mode=='empty_position' else b'BEGIN Position\nP1-KY-KE-GI-KI-OU-KI-GI-KE-KY\n+\nEND Position\n' if mode=='partial_position' else b'BEGIN Position\nPI51OU\n+\nEND Position\n' if mode=='no_king' else b'BEGIN Position\nPI\n+\nEND Position\n'
    f.write(b'LOGIN:Test OK\n'+(b'' if mode=='no_begin' else b'BEGIN Game_Summary\n')+b'Game_ID:example\nName+:Test\nName-:Other\nYour_Turn:'+turn+b'\nTotal_Time:60\n'+position+b'END Game_Summary\n')
    if mode in ('reject','abnormal','early_move'):
     assert f.readline()==b'AGREE\n';f.write({'reject':b'REJECT:example\n','abnormal':b'#ABNORMAL\n#CENSORED\n','early_move':b'+7776FU,T0\n'}[mode])
    assert f.readline()==b'',mode
   if mode in ('reject','abnormal'):
    conn,_=listener.accept();conn.settimeout(15)
    with conn,conn.makefile('rwb',buffering=0) as f:
     assert f.readline().startswith(b'LOGIN Test ');f.write(b'LOGIN:Test OK\n');p.stdin.write('q\n');p.stdin.flush();assert f.readline()==b'LOGOUT\n'
    p.wait(timeout=10)
   else:p.wait(timeout=10)
   out,err=p.communicate(timeout=10);events=[json.loads(line) for line in out.splitlines()]
   assert not any(e['event'] in ('game_started','game_finished') for e in events),(mode,out,err)
   if mode in ('reject','abnormal'):
    assert p.returncode==0 and any(e.get('state')=='reconnecting' for e in events),(mode,out,err)
   else:
    assert p.returncode!=0 and any(e['event']=='error' and (('指し手' if mode=='early_move' else '開始局面' if mode in ('empty_position','partial_position','no_king') else '対局情報') in e.get('message','')) for e in events),(mode,out,err)
  finally:
   listener.close()
   if p.poll() is None:p.kill();p.wait()
print('PASS: pre-start rejection, abort and invalid summaries never start a game')
