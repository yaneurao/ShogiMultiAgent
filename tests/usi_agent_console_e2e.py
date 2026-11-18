#!/usr/bin/env python3
"""The standalone adapter drains on q and renders the actual CSA position."""
import os, socket, subprocess, tempfile, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENT = Path(os.environ.get('SHOGIZONE_USI_AGENT', ROOT / 'target/debug/shogizone-participant-agent'))
with tempfile.TemporaryDirectory(prefix='usi-console-') as directory:
    engine = Path(directory) / 'engine.py'
    engine.write_text('''#!/usr/bin/env python3
import sys
for line in sys.stdin:
 line=line.strip()
 if line=='usi': print('usiok',flush=True)
 elif line=='isready': print('readyok',flush=True)
 elif line.startswith('go '): print('info depth 5 score cp 123 pv 7g7f 3c3d',flush=True);print('bestmove 7g7f',flush=True)
 elif line=='quit': break
''')
    engine.chmod(0o755)
    for playing in [False, True]:
        listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(15)
        proc=subprocess.Popen([AGENT,'--engine',engine,'--name','Test','--pool','floodgate-300-10F,PRIVATE_TEST_TRIP','--host',f'127.0.0.1:{listener.getsockname()[1]}','--record-dir',str(Path(directory)/'records')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        conn,_=listener.accept();conn.settimeout(15)
        with conn,conn.makefile('rwb',buffering=0) as stream:
            assert stream.readline().startswith(b'LOGIN Test ')
            stream.write(b'LOGIN:Test OK\n')
            if playing:
                stream.write(b'BEGIN Game_Summary\nGame_ID:shogizone+test-60-2F+Test+Other+20261118000000\nName+:Test\nName-:Other\nYour_Turn:+\nTotal_Time:60\nIncrement:2\nBEGIN Position\nPI\n+\nEND Position\nEND Game_Summary\n')
                assert stream.readline()==b'AGREE\n'
                stream.write(b'START:test\n')
                assert stream.readline().startswith(b'+7776FU,')
                stream.write(b"+7776FU,T0,'* 123 +7776FU -3334FU\n")
            proc.stdin.write('q\n');proc.stdin.flush()
            if playing:
                # No logout or disconnect is permitted before the game ends.
                conn.settimeout(1)
                try:
                    data=conn.recv(1024)
                    raise AssertionError(f'premature disconnect/command: {data!r}')
                except socket.timeout: pass
                conn.settimeout(15)
                stream.write(b'%TORYO,T1\n#WIN\n')
            assert stream.readline()==b'LOGOUT\n'
        out,err=proc.communicate(timeout=15);listener.close()
        assert proc.returncode==0,(out,err)
        assert '終了を受け付けました' in out and '接続完了' in out and 'エージェントを終了しました' in out,out
        assert 'PRIVATE_TEST_TRIP' not in out+err,(out,err)
        if playing:
            assert 'LOGIN : OK' in out and '対局終了: 勝ち' in out and 'ログアウト処理' in out,out
            assert '自分の指し手: 7g7f' in out and '評価値: 123' in out and '読み筋: 7g7f 3c3d' in out,out
            record=(Path(directory)/'records/shogizone+test-60-2F+Test+Other+20261118000000.csa').read_text();assert 'N+Test\nN-Other' in record and '+7776FU\nT0' in record and "'** 123 +7776FU -3334FU" in record and '%TORYO\nT1' in record,record
            assert ' 9 8 7 6 5 4 3 2 1' in out and '指し手: 7g7f' in out and 'sfen ' in out,out
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();listener.settimeout(15)
    proc=subprocess.Popen([AGENT,'--engine',engine,'--name','Test','--host',f'127.0.0.1:{listener.getsockname()[1]}'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    conn,_=listener.accept();conn.close()
    conn,_=listener.accept();conn.settimeout(15)
    with conn,conn.makefile('rwb',buffering=0) as stream:
        assert stream.readline().startswith(b'LOGIN Test ')
        stream.write(b'LOGIN:Test OK\n')
        proc.stdin.write('q\n');proc.stdin.flush()
        assert stream.readline()==b'LOGOUT\n'
    out,err=proc.communicate(timeout=15);listener.close()
    assert proc.returncode==0 and 'エラーが発生しました' in out and '1秒後に再接続します' in out,(out,err)
print('PASS: q drains active game, logs out while waiting, and prints move, analysis and board')
