//! 独立管理: ShogiZone の src/usi_agent.rs 由来。共通部分を修正した際は両方を確認する。
//! Participant-side USI engine ↔ CSA bridge. One process represents one connection.
use std::{io, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::{Child, ChildStdin, Command},
    sync::mpsc,
};

fn log_stderr(message: &str) {
    use std::io::Write;
    let _=writeln!(std::io::stderr().lock(), "{message}");
}
fn fail(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}
// Bound bytes before allocating a full line, including output without a newline.
async fn bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
    source: &str,
) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let count = newline.unwrap_or(available.len());
        if count > limit.saturating_sub(line.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{source}受信行が上限（{limit} byte）を超えました"),
            ));
        }
        line.extend_from_slice(&available[..count]);
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    match String::from_utf8(line) {
        Ok(line) => Ok(Some(line)),
        Err(error) => {
            // Windows engines sometimes emit legacy-encoded diagnostic text.
            // Accept only informational lines lossily; never alter commands or
            // the CSA protocol, where replacement could change a move.
            let bytes = error.into_bytes();
            if source == "USI" && (bytes.starts_with(b"info ") || bytes.starts_with(b"id name ") || bytes.starts_with(b"id author ")) {
                Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
            } else {
                Err(io::Error::new(io::ErrorKind::InvalidData, format!("{source}受信行はUTF-8である必要があります")))
            }
        }
    }
}
async fn forward_lines<R: tokio::io::AsyncBufRead + Unpin>(
    mut reader: R,
    tx: mpsc::Sender<io::Result<String>>,
    limit: usize,
    source: &str,
) {
    loop {
        let result = bounded_line(&mut reader, limit, source).await;
        match result {
            Ok(Some(line)) => {
                if tx.send(Ok(line)).await.is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => {
                let _ = tx.send(Err(e)).await;
                break;
            }
        }
    }
}
struct Engine {
    child: Child,
    input: ChildStdin,
    lines: mpsc::Receiver<io::Result<String>>,
    declarations: std::collections::BTreeMap<String, String>,
}
impl Engine {
    async fn send(&mut self, line: &str) -> io::Result<()> {
        self.input.write_all(format!("{line}\n").as_bytes()).await
    }
    async fn wait(&mut self, target: &str) -> io::Result<()> {
        tokio::time::timeout(Duration::from_secs(60), async {
            let mut diagnostics = std::collections::VecDeque::new();
            while let Some(line) = self.lines.recv().await {
                let line = line?;
                if let Some(error) =
                    line.strip_prefix("info string ShogiZone NUMA launcher error: ")
                {
                    let detail = error.chars().take(2048).collect::<String>();
                    return Err(fail(format!(
                        "{detail}{}",
                        startup_diagnostics(&diagnostics)
                    )));
                }
                if let Some(rest) = line.strip_prefix("option name ") {
                    if let Some((name, desc)) = rest.split_once(" type ") {
                        if self.declarations.len() >= 4096 || name.len() > 256 || desc.len() > 4096
                        {
                            return Err(fail("USIオプション宣言が上限を超えています"));
                        }
                        self.declarations.insert(name.into(), desc.into());
                    }
                }
                if line == target {
                    return Ok(());
                }
                if line.starts_with("info string ") {
                    if diagnostics.len() == 4 {
                        diagnostics.pop_front();
                    }
                    diagnostics.push_back(line.chars().take(512).collect::<String>());
                }
            }
            Err(fail(format!(
                "engine exited{}",
                startup_diagnostics(&diagnostics)
            )))
        })
        .await
        .map_err(|_| fail(format!("engine did not send {target}")))?
    }
    async fn ready(&mut self) -> io::Result<()> {
        self.send("isready").await?;
        self.wait("readyok").await
    }
}
fn startup_diagnostics(lines: &std::collections::VecDeque<String>) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        format!(
            "; engine output: {}",
            lines.iter().cloned().collect::<Vec<_>>().join(" | ")
        )
    }
}

pub type StatusCallback = std::sync::Arc<dyn Fn(&str) + Send + Sync>;
static MATCH_GATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static MATCH_REPLIES: std::sync::OnceLock<tokio::sync::Mutex<mpsc::UnboundedReceiver<()>>> = std::sync::OnceLock::new();
static APP_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static APP_OUTPUT: std::sync::OnceLock<std::sync::Arc<AppOutput>> = std::sync::OnceLock::new();
static APP_OUTPUT_FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static APP_OUTPUT_DRAIN: std::sync::OnceLock<tokio::sync::watch::Sender<bool>> = std::sync::OnceLock::new();
struct AppOutput { queue: std::sync::Mutex<AppOutputQueue>, changed: std::sync::Condvar }
#[derive(Default)]
struct AppOutputQueue { pending: std::collections::VecDeque<(String,bool)>, in_flight: bool }
fn disable_app_output() {
    APP_OUTPUT_FAILED.store(true,std::sync::atomic::Ordering::Relaxed);
    if let Some(drain)=APP_OUTPUT_DRAIN.get(){let _=drain.send(true);}
}
fn init_app_output() {
    let output=std::sync::Arc::new(AppOutput {queue:std::sync::Mutex::new(AppOutputQueue::default()),changed:std::sync::Condvar::new()});
    let _=APP_OUTPUT.set(output.clone());
    std::thread::spawn(move || {
        use std::io::Write;
        let stdout=std::io::stdout();let mut writer=stdout.lock();
        loop {
            let mut state=output.queue.lock().unwrap_or_else(|e|e.into_inner());
            while state.pending.is_empty(){state=output.changed.wait(state).unwrap_or_else(|e|e.into_inner());}
            let (line,_)=state.pending.pop_front().unwrap();state.in_flight=true;drop(state);
            let result=writer.write_all(line.as_bytes()).and_then(|_|writer.write_all(b"\n")).and_then(|_|writer.flush());
            let mut state=output.queue.lock().unwrap_or_else(|e|e.into_inner());state.in_flight=false;output.changed.notify_all();
            if result.is_err(){disable_app_output();break;}
        }
    });
}
fn app_mode() -> bool { APP_MODE.load(std::sync::atomic::Ordering::Relaxed) }
fn app_event(value: serde_json::Value) {
    if !app_mode()||APP_OUTPUT_FAILED.load(std::sync::atomic::Ordering::Relaxed){return;}
    let Some(output)=APP_OUTPUT.get() else {return};
    let telemetry=matches!(value["event"].as_str(),Some("analysis_update" | "search_metrics" | "engine_log" | "search_string"));
    let mut state=output.queue.lock().unwrap_or_else(|e|e.into_inner());
    if state.pending.len()>=512 {
        if let Some(index)=state.pending.iter().position(|(_,is_telemetry)|*is_telemetry){state.pending.remove(index);}
        else if telemetry{return;}
        else if state.pending.len()>=2048 {disable_app_output();return;}
    }
    state.pending.push_back((value.to_string(),telemetry));output.changed.notify_one();
}
fn flush_app_output() {
    if let Some(output)=APP_OUTPUT.get(){
        let state=output.queue.lock().unwrap_or_else(|e|e.into_inner());
        let _=output.changed.wait_timeout_while(state,Duration::from_secs(2),|state|!state.pending.is_empty()||state.in_flight);
    }
}
fn console_progress(status: Option<&StatusCallback>, message: &str) {
    if status.is_none() { if app_mode() { app_event(serde_json::json!({"event":"log","message":message})); } else { println!("{message}"); } }
}
pub async fn run_cli(args: impl Iterator<Item = String>) -> io::Result<()> {
    use std::io::BufRead;
    let mut arguments: Vec<String> = args.collect();
    if arguments.len()==2 && arguments[0]=="--inspect-record" {return inspect_record(&arguments[1]);}
    if arguments == ["--app-mode"] {
        APP_MODE.store(true, std::sync::atomic::Ordering::Relaxed);
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        if line.len() > 65536 { return Err(fail("参加設定が大きすぎます")); }
        let config: serde_json::Value = serde_json::from_str(&line).map_err(|_| fail("参加設定の形式が正しくありません"))?;
        MATCH_GATE.store(config["match_gate"].as_bool().unwrap_or(false), std::sync::atomic::Ordering::Relaxed);
        let value = |key: &str| config[key].as_str().unwrap_or("").to_string();
        let trip = value("trip");
        if trip.chars().any(|c| c.is_whitespace() || c.is_control() || c == ',') { return Err(fail("tripに使用できない文字があります")); }
        let pool = value("pool");
        let pool = if pool.is_empty() { "floodgate-300-10F".to_string() } else { pool };
        if pool.contains(',') { return Err(fail("対局条件にカンマは使えません")); }
        let engine = value("engine");
        arguments = vec!["--engine".into(),engine.clone(),"--host".into(),value("host"),"--name".into(),value("name"),"--pool".into(),if trip.is_empty(){pool}else{format!("{pool},{trip}")}];
        if let Some(dir) = std::path::Path::new(&engine).parent().filter(|p| !p.as_os_str().is_empty()) { arguments.extend(["--working-dir".into(),dir.to_string_lossy().into_owned()]); }
        if config["ponder"].as_bool().unwrap_or(false) { arguments.push("--ponder".into()); }
        let directory = value("record_dir");
        if !directory.is_empty() { arguments.extend(["--record-dir".into(),directory]); }
        if let Some(options) = config["options"].as_array() {
            for option in options { arguments.extend(["--option".into(),option.as_str().ok_or_else(||fail("エンジンオプションが不正です"))?.into()]); }
        }
    }
    let (match_tx, match_rx) = mpsc::unbounded_channel();
    let _ = MATCH_REPLIES.set(tokio::sync::Mutex::new(match_rx));
    let (quit, drain) = tokio::sync::watch::channel(false);
    if app_mode(){let _=APP_OUTPUT_DRAIN.set(quit.clone());init_app_output();}
    let input_quit = quit.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) if line.trim().eq_ignore_ascii_case("q") => {
                    if app_mode() { app_event(serde_json::json!({"event":"stopping","message":"終局を待って終了します"})); } else { println!("終了を受け付けました。対局中の場合は終局を待ちます。"); }
                    let _ = input_quit.send(true);
                    if !app_mode() { break; }
                }
                Ok(line) if app_mode() && line.trim().eq_ignore_ascii_case("c") => {
                    let _ = input_quit.send(false);
                    app_event(serde_json::json!({"event":"resumed","message":"終了予約を取り消しました"}));
                }
                Ok(line) if app_mode() && line.trim() == "allow" => { let _ = match_tx.send(()); }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        // If the desktop app disappears, its stdin pipe closes. Do not leave
        // an unattended engine running: finish its current game, then exit.
        if app_mode() { let _ = input_quit.send(true); }
    });
    let result = run_with_control(arguments.into_iter(), None, Some(drain)).await;
    if let Err(ref e) = result { app_event(serde_json::json!({"event":"error","message":e.to_string()})); }
    app_event(serde_json::json!({"event":"exited"}));
    flush_app_output();
    drop(quit);
    result
}
fn inspect_record(path:&str)->io::Result<()> {
    let data=std::fs::read(path)?;if data.len()>16*1024*1024{return Err(fail("棋譜が大きすぎます"));}
    let text=std::str::from_utf8(&data).map_err(|_|fail("棋譜の文字コードが不正です"))?;
    let lines:Vec<String>=text.lines().map(str::to_owned).collect();
    if !lines.last().is_some_and(|l|l.starts_with("'$END_TIME:")){return Err(fail("棋譜はまだ完了していません"));}
    let result=lines.iter().filter_map(|l|l.strip_prefix("'#")).filter(|v|["WIN","LOSE","DRAW","CENSORED"].contains(v)).last().ok_or_else(||fail("棋譜に結果がありません"))?;
    let reason=lines.iter().filter_map(|l|l.strip_prefix("'#")).filter(|v|!["WIN","LOSE","DRAW","CENSORED"].contains(v)).last().map(|v|format!("#{v}"));
    let event=lines.iter().find_map(|l|l.strip_prefix("$EVENT:")).ok_or_else(||fail("棋譜に対局IDがありません"))?;
    let (mut pos,moves,info,evals)=rshogi_csa::parse_csa_full_with_evals(text).map_err(|e|fail(e.to_string()))?;
    let initial=position_initial_sfen(&lines,&pos)?;pos.ply=initial.split_whitespace().last().and_then(|v|v.parse().ok()).ok_or_else(||fail("棋譜の手数が不正です"))?;
    let mut comments:Vec<Vec<String>>=Vec::new();for line in &lines {let b=line.as_bytes();if b.len()>=7&&matches!(b[0],b'+'|b'-')&&b[1..5].iter().all(u8::is_ascii_digit)&&b[5..7].iter().all(u8::is_ascii_uppercase){comments.push(Vec::new());}else if let Some(value)=line.strip_prefix("'**"){if let Some(last)=comments.last_mut(){*last=value.split_whitespace().skip(1).take(32).map(str::to_owned).collect();}}}
    let mut frames=vec![serde_json::json!({"sfen":initial,"ply":display_ply(&initial,0)})];let mut n=0usize;
    for item in moves {if let rshogi_csa::ParsedMove::Normal(m)=item {let mut pv_pos=pos.clone();let mut pv=Vec::new();if let Some(tokens)=comments.get(n){for token in tokens{let Ok(usi)=rshogi_csa::csa_move_to_usi(token,&pv_pos)else{break};if pv_pos.apply_csa_move(token).is_err(){break;}pv.push(usi);}}let usi=rshogi_csa::csa_move_to_usi(&m.mv,&pos).map_err(|e|fail(e.to_string()))?;pos.apply_csa_move(&m.mv).map_err(|e|fail(e.to_string()))?;n+=1;frames.push(serde_json::json!({"sfen":pos.to_sfen(),"ply":display_ply(&initial,n),"move":usi,"elapsed":m.time_sec,"evaluation":evals.get(n-1).copied().flatten(),"pv":pv}));}}
    println!("{}",serde_json::json!({"event":event,"black":info.black_name,"white":info.white_name,"result":format!("#{result}"),"reason":reason,"frames":frames}));Ok(())
}
pub async fn run_with_control(
    args: impl Iterator<Item = String>,
    status: Option<StatusCallback>,
    drain: Option<tokio::sync::watch::Receiver<bool>>,
) -> io::Result<()> {
    let mut name = "Engine".to_string();
    let mut host = "127.0.0.1:4081".to_string();
    let mut pool = "floodgate-300-10F".to_string();
    let mut path = None;
    let mut options = Vec::new();
    let mut once = false;
    let mut ponder = false;
    let mut strict_options = false;
    let mut required_options = Vec::<String>::new();
    let mut engine_option_dir = None::<std::path::PathBuf>;
    let mut game_limit = None::<u64>;
    let mut completed_games = 0u64;
    let mut engine_args = Vec::new();
    let mut working_dir = None;
    let mut record_dir = None::<std::path::PathBuf>;
    let mut args = args;
    while let Some(arg) = args.next() {
        if arg == "--strict-options" {
            strict_options = true;
            continue;
        }
        if arg == "--ponder" { ponder = true; continue; }
        if arg == "--once" {
            once = true;
            continue;
        }
        if arg == "--" {
            engine_args.extend(args);
            break;
        }
        if arg == "--help" {
            println!(
                "usi-agent --engine /path/to/engine --name Engine-v1 [--host 127.0.0.1:4081] [--pool floodgate-300-10F] [--option Threads=1] [--working-dir /local/work] [--record-dir /path/to/records] [--once] [-- engine-args]"
            );
            return Ok(());
        }
        let value = args
            .next()
            .ok_or_else(|| fail(format!("missing value: {arg}")))?;
        match arg.as_str() {
            "--games" => game_limit = Some(value.parse().map_err(|_| fail("invalid game limit"))?),
            "--name" => name = value,
            "--host" => host = value,
            "--pool" => pool = value,
            "--engine" => path = Some(value),
            "--option" => options.push(value),
            "--required-option" => required_options.push(value),
            "--engine-option-dir" => engine_option_dir = Some(value.into()),
            "--working-dir" => working_dir = Some(value),
            "--record-dir" => record_dir = Some(value.into()),
            _ => return Err(fail(format!("unknown option: {arg}"))),
        }
    }
    if name.is_empty()
        || name.len() > 40
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-@.".contains(&c))
    {
        return Err(fail("name must use 1-40 ASCII letters/digits or _-@."));
    }
    if pool.chars().any(char::is_whitespace) || pool.chars().any(char::is_control) {
        return Err(fail("invalid pool"));
    }
    if let Some(dir) = &record_dir { std::fs::create_dir_all(dir)?; }
    if strict_options || !required_options.is_empty() {
        let cwd = working_dir
            .as_ref()
            .map(std::path::PathBuf::from)
            .unwrap_or(std::env::current_dir()?);
        let mut files = vec![cwd.join("engine_options.txt")];
        let engine_dir = engine_option_dir.clone().or_else(|| path.as_ref().and_then(|p: &String| std::path::Path::new(p).parent()).map(|p| p.to_path_buf()));
        if let Some(dir) = engine_dir { files.push(dir.join("engine_options.txt")); }
        if let Some((_, value)) = options
            .iter()
            .rev()
            .filter_map(|s| s.split_once('='))
            .find(|(name, _)| name.eq_ignore_ascii_case("EvalDir"))
        {
            files.push(cwd.join(value).join("eval_options.txt"));
        }
        for file in files {
            match tokio::fs::metadata(&file).await {
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
                Ok(meta) if meta.len() > 1024 * 1024 => {
                    return Err(fail("オプションファイルが大きすぎます"));
                }
                Ok(_) => {}
            }
            let text = tokio::fs::read_to_string(&file).await?;
            for line in text.lines() {
                let line = line.split("//").next().unwrap_or("").trim();
                if line.is_empty() {
                    continue;
                }
                let key = if let Some(rest) = line.strip_prefix("option name ") {
                    rest.split(" type ").next().unwrap_or(rest)
                } else if let Some(rest) = line.strip_prefix("setoption name ") {
                    rest.split(" value ").next().unwrap_or(rest)
                } else {
                    line.split(['=', ' ', '\t']).next().unwrap_or("")
                };
                if (strict_options || required_options.iter().any(|name| name.eq_ignore_ascii_case(key.trim()))) && options
                    .iter()
                    .filter_map(|s| s.split_once('='))
                    .any(|(name, _)| name.trim().eq_ignore_ascii_case(key.trim()))
                {
                    return Err(fail(format!(
                        "{} がUSIオプション {key} を上書きします。重複する設定を削除してください",
                        file.display()
                    )));
                }
            }
        }
    }
    let mut command = Command::new(path.ok_or_else(|| fail("--engine is required"))?);
    command
        .args(engine_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if app_mode(){Stdio::piped()}else{Stdio::inherit()})
        .kill_on_drop(true);
    if let Some(directory) = working_dir {
        command.current_dir(directory);
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::process::id();
        // SAFETY: only async-signal-safe Linux syscalls are used after fork.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() as u32 != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    'engine: loop {
    console_progress(status.as_ref(), "エンジンを起動しています...");
    let mut child = command.spawn()?;
    if let Some(mut stderr)=child.stderr.take(){tokio::spawn(async move {let mut buf=[0u8;4096];while let Ok(n)=stderr.read(&mut buf).await {if n==0{break;}app_event(serde_json::json!({"event":"engine_log","message":String::from_utf8_lossy(&buf[..n]).trim_end()}));}});}
    if let Some(s) = &status {
        s("spawned");
    }
    let input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(forward_lines(BufReader::new(output), tx, 16 * 1024, "USI"));
    let mut engine = Engine {
        child,
        input,
        lines: rx,
        declarations: Default::default(),
    };
    engine.send("usi").await?;
    engine.wait("usiok").await?;
    console_progress(status.as_ref(), "エンジンのUSI初期化が完了しました。");
    for option in &options {
        let (key, value) = option
            .split_once('=')
            .ok_or_else(|| fail("--option expects Name=Value"))?;
        if option.chars().any(char::is_control) {
            return Err(fail("invalid engine option"));
        }
        if strict_options || required_options.iter().any(|name| name.eq_ignore_ascii_case(key)) {
            let declaration = engine.declarations.iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value)
                .ok_or_else(|| fail(format!("USIオプションがありません: {key}")))?;
            let words = declaration.split_whitespace().collect::<Vec<_>>();
            if words.first() == Some(&"check") && !["true", "false"].contains(&value) {
                return Err(fail(format!("{key}: true または false を指定してください")));
            }
            if words.first() == Some(&"combo") {
                let choices = declaration.split(" var ").skip(1).collect::<Vec<_>>();
                if !choices.is_empty() && !choices.iter().any(|v| v.eq_ignore_ascii_case(value)) {
                    return Err(fail(format!("{key}: 選択肢にない値です: {value}")));
                }
            }
            if words.first() == Some(&"spin") {
                let n = value
                    .parse::<i64>()
                    .map_err(|_| fail(format!("{key}: 整数を指定してください")))?;
                for (bound, less) in [("min", true), ("max", false)] {
                    if let Some(v) = words
                        .iter()
                        .position(|v| *v == bound)
                        .and_then(|i| words.get(i + 1))
                        .and_then(|s| s.parse::<i64>().ok())
                    {
                        if (less && n < v) || (!less && n > v) {
                            return Err(fail(format!("USIオプションの範囲外です: {key}")));
                        }
                    }
                }
            }
        }
        engine
            .send(&format!("setoption name {key} value {value}"))
            .await?;
    }
    if ponder { engine.send("setoption name USI_Ponder value true").await?; }
    let mut restart_after_abort=false;
    loop {
        if drain.as_ref().is_some_and(|d| *d.borrow()) {
            break;
        }
        engine.send("usinewgame").await?;
        engine.ready().await?;
        app_event(serde_json::json!({"event":"state","state":"connecting"}));
        console_progress(status.as_ref(), &format!("対局サーバーに接続しています: {host}"));
        if let Some(s) = &status {
            s("connecting");
        }
        let mut game_started = false;
        let mut authenticated = false;
        let result = play(
            &mut engine,
            &host,
            &name,
            &pool,
            status.as_ref(),
            drain.as_ref(),
            record_dir.as_deref(),
            ponder,
            &mut game_started,
            &mut authenticated,
        )
        .await;
        if let Err(ref e) = result {
            if matches!(e.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::InvalidInput) { if !authenticated && e.kind()==io::ErrorKind::PermissionDenied {app_event(serde_json::json!({"event":"state","state":"login_error","message":e.to_string()}));} return Err(io::Error::new(e.kind(), e.to_string())); }
            app_event(serde_json::json!({"event":"state","state":"reconnecting","phase":if authenticated {"game"} else {"login"},"message":e.to_string()}));
            log_stderr(&format!("agent: {e}"));
            if let Some(s) = &status {
                s("reconnecting");
            } else if !app_mode() {
                println!("接続または対局でエラーが発生しました: {e}");
            }
        }
        if result.as_ref().is_ok_and(|done| matches!(done, PlayOutcome::Completed | PlayOutcome::Aborted)) {
            completed_games += 1;
        }
        if result.as_ref().is_ok_and(|done| matches!(done, PlayOutcome::Aborted)) { restart_after_abort=true; break; }
        if result.is_err() && game_started && !once && !drain.as_ref().is_some_and(|d| *d.borrow()) {
            restart_after_abort=true; break;
        }
        if once || drain.as_ref().is_some_and(|d| *d.borrow()) || game_limit.is_some_and(|limit| completed_games >= limit) {
            break;
        }
        // Normal game completion reconnects immediately. Failed connections use a short retry delay.
        if result.is_err() {
            console_progress(status.as_ref(), "1秒後に再接続します...");
            tokio::time::sleep(Duration::from_secs(1)).await;
        } else {
            console_progress(status.as_ref(), "次の対局に向けて再接続します...");
        }
        if engine.child.try_wait()?.is_some() {
            return Err(fail("engine exited"));
        }
    }
    if let Err(e) = engine.send("quit").await {
        if !restart_after_abort { return Err(e); }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), engine.child.wait()).await;
    if restart_after_abort && !once && !drain.as_ref().is_some_and(|d| *d.borrow()) && !game_limit.is_some_and(|limit| completed_games >= limit) {
        console_progress(status.as_ref(), "中断した対局のためエンジンを再起動します...");
        continue 'engine;
    }
    break 'engine;
    }
    console_progress(status.as_ref(), "エージェントを終了しました。");
    Ok(())
}
struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn report_record_error(path: Option<&std::path::Path>, message: &str) {
    if !app_mode() { log_stderr(message); }
    app_event(serde_json::json!({"event":"record_error","path":path.map(|p|p.to_string_lossy().into_owned()),"message":message}));
}
struct CsaRecord {
    file: std::fs::File,
    path: std::path::PathBuf,
    failed: bool,
    special_written: bool,
    enabled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl CsaRecord {
    fn create(dir: &std::path::Path, id: &str, black: &str, white: &str, position: &[String], enabled: std::sync::Arc<std::sync::atomic::AtomicBool>, shared_path:&std::sync::Mutex<Option<std::path::PathBuf>>) -> io::Result<Self> {
        use std::io::Write;
        let now = chrono::Utc::now().with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap());
        // Game_ID is supplied by the server. Never allow it to escape the
        // chosen directory or overwrite an earlier game's record.
        let stem: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.+".contains(*c)).take(180).collect();
        let stem = if stem.is_empty() || stem == "." || stem == ".." { format!("game-{}", now.format("%Y%m%d%H%M%S")) } else { stem };
        let (mut file, path) = (0..10000).find_map(|n| {
            let name = if n == 0 { format!("{stem}.csa") } else { format!("{stem}-{n}.csa") };
            let path = dir.join(name);
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => Some(Ok((file, path))),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => None,
                Err(e) => Some(Err(e)),
            }
        }).unwrap_or_else(|| Err(fail("棋譜ファイル名を確保できません")))?;
        *shared_path.lock().unwrap_or_else(|e|e.into_inner())=Some(path.clone());
        if enabled.load(std::sync::atomic::Ordering::Acquire) {if app_mode() { app_event(serde_json::json!({"event":"record","path":path.to_string_lossy()})); } else { println!("棋譜保存: {}", path.display()); }}
        let written = (|| -> io::Result<()> {
            writeln!(file, "V2.2\nN+{black}\nN-{white}\n$EVENT:{id}\n$START_TIME:{}", now.format("%Y/%m/%d %H:%M:%S"))?;
            for line in position { writeln!(file, "{line}")?; }
            Ok(())
        })();
        let failed = if let Err(e) = written { if enabled.load(std::sync::atomic::Ordering::Acquire){report_record_error(Some(&path), &format!("棋譜を保存できません: {e}"));} true } else { false };
        Ok(Self { file, path, failed, special_written: false, enabled })
    }
    fn write_wire(&mut self, line: &str) {
        use std::io::Write;
        if self.failed { return; }
        if line.starts_with('%') { self.special_written = true; }
        let result = (|| -> io::Result<()> {
            if line.starts_with('#') {
                writeln!(self.file, "'{line}")?;
            } else {
                let mut parts = line.split(',');
                if let Some(move_) = parts.next() { writeln!(self.file, "{move_}")?; }
                for part in parts {
                    if part.starts_with('T') && part[1..].bytes().all(|b| b.is_ascii_digit()) {
                        writeln!(self.file, "{part}")?;
                    } else if let Some(comment) = part.strip_prefix('\'') {
                        writeln!(self.file, "'*{comment}")?;
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = result { self.failed = true; if self.enabled.load(std::sync::atomic::Ordering::Acquire){report_record_error(Some(&self.path), &format!("棋譜の書き込みに失敗しました: {e}"));} }
    }
    fn finish(mut self, reason: &str, verdict: &str, side: char, black: &str, white: &str) {
        use std::io::Write;
        let now = chrono::Utc::now().with_timezone(&chrono::FixedOffset::east_opt(9 * 3600).unwrap());
        if self.failed { return; }
        // CSA servers often send only #RESIGN/#WIN, not the original %TORYO.
        // Fill in the standard special move when its meaning is unambiguous.
        let (code, marker) = match reason {
            "#RESIGN" => (Some("toryo"), Some("%TORYO")),
            "#TIME_UP" => (Some("time up"), Some("%TIME_UP")),
            "#SENNICHITE" => (Some("sennichite"), Some("%SENNICHITE")),
            "#JISHOGI" => (Some("kachi"), Some("%KACHI")),
            "#ILLEGAL_MOVE" => (Some("illegal move"), None),
            "#OUTE_SENNICHITE" => (Some("oute_sennichite"), None),
            "#MAX_MOVES" => (Some("max_moves"), None),
            "#ABNORMAL" => (Some("abnormal"), None),
            _ => (None, None),
        };
        let results = match verdict {
            "#WIN" if side == '+' => Some(("win", "lose")),
            "#WIN" => Some(("lose", "win")),
            "#LOSE" if side == '+' => Some(("lose", "win")),
            "#LOSE" => Some(("win", "lose")),
            "#DRAW" => Some(("draw", "draw")),
            "#CENSORED" if reason=="#MAX_MOVES" => Some(("draw", "draw")),
            _ => None,
        };
        let written = (|| -> io::Result<()> {
            if !self.special_written { if let Some(marker) = marker.or(if verdict=="#DRAW" {Some("%HIKIWAKE")} else {None}) { writeln!(self.file, "{marker}")?; } }
            if let (Some(code), Some((b, w))) = (code, results) { writeln!(self.file, "'summary:{code}:{black} {b}:{white} {w}")?; }
            writeln!(self.file, "'$END_TIME:{}", now.format("%Y/%m/%d %H:%M:%S"))?;
            self.file.flush()
        })();
        if let Err(e) = written { if self.enabled.load(std::sync::atomic::Ordering::Acquire){report_record_error(Some(&self.path), &format!("棋譜の保存に失敗しました: {e}"));} }
    }
}
enum RecordCommand { Line(String), Finish{reason:String,verdict:String,side:char,black:String,white:String,done:tokio::sync::oneshot::Sender<()>} }
struct AsyncRecord { tx:std::sync::mpsc::SyncSender<RecordCommand>, enabled:std::sync::Arc<std::sync::atomic::AtomicBool>, path:std::sync::Arc<std::sync::Mutex<Option<std::path::PathBuf>>> }
impl AsyncRecord {
 fn start(dir:std::path::PathBuf,id:String,black:String,white:String,position:Vec<String>)->Self {
  let (tx,rx)=std::sync::mpsc::sync_channel(4096);let enabled=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));let path=std::sync::Arc::new(std::sync::Mutex::new(None));let flag=enabled.clone();let shared=path.clone();
  std::thread::spawn(move||{
   let mut record=match CsaRecord::create(&dir,&id,&black,&white,&position,flag.clone(),&shared){Ok(r)=>Some(r),Err(e)=>{if flag.load(std::sync::atomic::Ordering::Acquire){report_record_error(None,&format!("棋譜を保存できません: {e}"));}None}};
   while let Ok(cmd)=rx.recv(){if !flag.load(std::sync::atomic::Ordering::Acquire){break;}match cmd{RecordCommand::Line(line)=>{if let Some(r)=record.as_mut(){r.write_wire(&line);}},RecordCommand::Finish{reason,verdict,side,black,white,done}=>{if let Some(r)=record.take(){r.finish(&reason,&verdict,side,&black,&white);}let _=done.send(());break;}}}
  });Self{tx,enabled,path}
 }
 fn fail(&self,message:&str){if self.enabled.swap(false,std::sync::atomic::Ordering::AcqRel){let p=self.path.lock().unwrap_or_else(|e|e.into_inner()).clone();report_record_error(p.as_deref(),message);}}
 fn write_wire(&self,line:&str){if self.enabled.load(std::sync::atomic::Ordering::Acquire)&&self.tx.try_send(RecordCommand::Line(line.to_owned())).is_err(){self.fail("棋譜の保存が追いつかないため、記録を中断しました。");}}
 async fn finish(self,reason:&str,verdict:&str,side:char,black:&str,white:&str){if !self.enabled.load(std::sync::atomic::Ordering::Acquire){return;}let (done,wait)=tokio::sync::oneshot::channel();if self.tx.try_send(RecordCommand::Finish{reason:reason.into(),verdict:verdict.into(),side,black:black.into(),white:white.into(),done}).is_err(){self.fail("棋譜の保存が追いつかないため、記録を中断しました。");return;}if !matches!(tokio::time::timeout(Duration::from_secs(2),wait).await,Ok(Ok(()))){self.fail("棋譜の保存が完了しなかったため、記録を確認してください。");}}
}
impl Drop for AsyncRecord {fn drop(&mut self){self.enabled.store(false,std::sync::atomic::Ordering::Release);}}
// The extension is a CSA comment, so ordinary CSA clients can ignore it.
// It describes the initial board, before any opening moves included in Position.
fn position_initial_sfen(lines: &[String], initial: &rshogi_csa::Position) -> io::Result<String> {
    let mut ply = None;
    for line in lines {
        if let Some(value) = line.strip_prefix("'ShogiZone_Initial_Ply:") {
            let n = value
                .parse::<u32>()
                .ok()
                .filter(|&n| n > 0)
                .ok_or_else(|| fail("invalid ShogiZone initial ply"))?;
            if ply.replace(n).is_some() {
                return Err(fail("duplicate ShogiZone initial ply"));
            }
        }
    }
    let sfen = initial.to_sfen();
    if let Some(n) = ply {
        let (board, _) = sfen
            .rsplit_once(' ')
            .ok_or_else(|| fail("invalid initial SFEN"))?;
        Ok(format!("{board} {n}"))
    } else {
        Ok(sfen)
    }
}
fn display_ply(initial_sfen: &str, moves: usize) -> u64 {
    initial_sfen.split_whitespace().last().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1).saturating_sub(1).saturating_add(moves as u64)
}
fn opening_clocks(lines: &[String], clocks: [u64; 2]) -> io::Result<Vec<([u64; 2], Option<u64>)>> {
    let mut moves: Vec<Option<u64>> = Vec::new();
    for line in lines {
        for part in line.split(',') {
            if (part.starts_with('+') || part.starts_with('-')) && part.len() >= 7 {
                moves.push(None);
            } else if let Some(value) = part.strip_prefix('T') {
                let elapsed = value.parse::<u64>().map_err(|_| fail("開始局面の消費時間が不正です"))?;
                if let Some(last) = moves.last_mut() { *last = Some(elapsed); }
            }
        }
    }
    // Position contains the prescribed opening, which precedes START and has
    // not used either player's clock. Its T fields describe that history only.
    let mut frames = vec![(clocks, None)];
    for elapsed in moves {
        frames.push((clocks, elapsed));
    }
    Ok(frames)
}
#[derive(Clone, Copy, Default)]
struct RawTime { total: Option<u64>, increment: Option<u64>, byoyomi: Option<u64> }
#[derive(Debug)]
enum PlayOutcome { Completed, Drained, Aborted }

async fn play(
    engine: &mut Engine,
    host: &str,
    name: &str,
    pool: &str,
    status: Option<&StatusCallback>,
    drain: Option<&tokio::sync::watch::Receiver<bool>>,
    record_dir: Option<&std::path::Path>,
    ponder_enabled: bool,
    started: &mut bool,
    authenticated: &mut bool,
) -> io::Result<PlayOutcome> {
    let socket = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(host))
        .await
        .map_err(|_| fail("connect timeout"))??;
    socket.set_nodelay(true)?;
    console_progress(status, "接続完了。ログインしています...");
    let (read, mut write) = socket.into_split();
    let (tx, mut csa) = mpsc::channel(8);
    let reader_task = AbortOnDrop(tokio::spawn(forward_lines(
        BufReader::new(read),
        tx,
        4096,
        "CSA",
    )));
    write
        .write_all(format!("LOGIN {name} {pool}\n").as_bytes())
        .await?;
    let mut drain = drain.cloned();
    // CSA servers accept empty lines as keepalives (as used by Shogidokoro).
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await; // The first tick is immediate; do not send it at login.
    let login_timeout = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(login_timeout);
    let prestart_timeout = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(prestart_timeout);
    let show_board = status.is_none();
    // A search must be stopped and its bestmove consumed before reusing the engine.
    let mut thinking=false;
    let mut pondering: Option<String> = None;
    let mut ponder_stopping=false;
    let mut ponder_stop_deadline: Option<tokio::time::Instant>=None;
    let mut pending_ponder: Option<String> = None;
    let mut ponder_analysis = Analysis::default();
    let mut ponder_sfen = String::new();
    let result=async {
        let mut committed=false;let mut logged_in=false;let mut summary_complete=false;let mut summary_open=false;let mut game_started=false;let mut have_side=false;let mut have_position=false;let mut termination_reason=String::new();let mut game_id=String::new();let mut black=String::new();let mut white=String::new();let mut record: Option<AsyncRecord>=None;
        let mut side='+';let mut common_time=RawTime::default();let mut side_time=[RawTime::default();2];let mut time_target=None;let mut inc=[0u64;2];let mut byo=0u64;let mut clocks=[0u64;2];let mut moves=Vec::<String>::new();let mut pos=rshogi_csa::initial_position();let mut initial_sfen=rshogi_core::position::SFEN_HIRATE.to_string();let mut position_lines=Vec::<String>::new();let mut opening_frames=Vec::<serde_json::Value>::new();let mut in_position=false;let mut analysis=Analysis::default();let mut turn_started=std::time::Instant::now();let mut terminal_elapsed_ms=None;
        loop {
            if !committed && drain.as_ref().is_some_and(|d| *d.borrow()) {let _ = write.write_all(b"LOGOUT\n").await; console_progress(status,"ログアウト処理を行いました。");if let Some(s)=status{s("drained");}return Ok(PlayOutcome::Drained);}
            tokio::select! { biased;
            _=async {if let Some(deadline)=ponder_stop_deadline{tokio::time::sleep_until(deadline).await}else{std::future::pending::<()>().await}},if ponder_stopping=>{ponder_stopping=false;return Err(io::Error::new(io::ErrorKind::InvalidInput,"探索停止後のbestmoveを10秒以内に受信できませんでした"));}
            line=csa.recv()=> {
                let line=line.ok_or_else(||fail("CSA connection closed"))??;
                if line.starts_with("REJECT:") {return Err(fail("対局の開始が拒否されました。接続し直します。"));}
                if line=="LOGIN:incorrect" {return Err(io::Error::new(io::ErrorKind::PermissionDenied,"ログインを拒否されました。プレイヤー名、対局条件、tripを確認してください。"));}
                if line.starts_with("LOGIN:") && line.ends_with(" OK") {logged_in=true;*authenticated=true;if let Some(s)=status{s("waiting");}else{app_event(serde_json::json!({"event":"state","state":"waiting"}));console_progress(status,"LOGIN : OK　対局待機中");}}
                if let Some(v)=line.strip_prefix("Game_ID:"){game_id=v.to_string();}
                if let Some(v)=line.strip_prefix("Name+:"){black=v.to_string();}
                if let Some(v)=line.strip_prefix("Name-:"){white=v.to_string();}
                if line.starts_with("BEGIN Game_Summary")||line.starts_with("Your_Turn:")||line.starts_with("START:"){committed=true;}
                if line=="BEGIN Game_Summary" {if !logged_in||summary_complete||summary_open{return Err(fail("対局情報の受信順序が不正です。"));}summary_open=true;prestart_timeout.as_mut().reset(tokio::time::Instant::now()+Duration::from_secs(30));console_progress(status,"対局情報を受信しています...");}
                if line.starts_with("START:"){if let Some(s)=status{s("playing");}}
                if let Some(v)=line.strip_prefix("Your_Turn:"){side=match v.trim(){"+"=>'+',"-"=>'-',_=>return Err(io::Error::new(io::ErrorKind::InvalidInput,"対局情報の手番が不正です。"))};have_side=true;}
                if let Some(v)=line.strip_prefix("Time_Unit:") {if v.trim()!="1sec" {return Err(io::Error::new(io::ErrorKind::InvalidInput,format!("未対応のCSA時間単位です: {}。1sec の対局条件を使用してください。",v.trim())));}}
                if let Some(v)=line.strip_prefix("Delay:") {if v.trim()!="0" {return Err(io::Error::new(io::ErrorKind::InvalidInput,format!("未対応のCSA時間遅延です: {}。Delay:0 の対局条件を使用してください。",v.trim())));}}
                match line.as_str() {"BEGIN Time+"=>time_target=Some(0),"BEGIN Time-"=>time_target=Some(1),"BEGIN Time"|"END Time"|"END Time+"|"END Time-"=>time_target=None,_=>{}}
                let time=if let Some(i)=time_target {&mut side_time[i]} else {&mut common_time};
                if let Some(v)=line.strip_prefix("Total_Time:"){time.total=Some(v.parse().map_err(|_|fail("invalid total time"))?);}
                if let Some(v)=line.strip_prefix("Increment:"){time.increment=Some(v.parse().map_err(|_|fail("invalid increment"))?);}
                if let Some(v)=line.strip_prefix("Byoyomi:"){time.byoyomi=Some(v.parse().map_err(|_|fail("invalid byoyomi"))?);}
                if line=="BEGIN Position" {in_position=true;position_lines.clear();continue;}
                if line=="END Position" {
                    if !in_position || !position_lines.iter().any(|line| line.starts_with("PI") || line.starts_with("P1") || line.strip_prefix("P+").or_else(||line.strip_prefix("P-")).is_some_and(|pieces|pieces.as_bytes().chunks_exact(4).any(|p|&p[..2]!=b"00"))) {return Err(io::Error::new(io::ErrorKind::InvalidInput,"開始局面の盤面情報がありません。"));}
                    let ranks:Vec<u8>=position_lines.iter().filter_map(|line|{let b=line.as_bytes();(b.len()>=2&&b[0]==b'P'&&(b'1'..=b'9').contains(&b[1])).then(||b[1])}).collect();
                    if !ranks.is_empty() && ((b'1'..=b'9').any(|rank|ranks.iter().filter(|r|**r==rank).count()!=1)) {return Err(io::Error::new(io::ErrorKind::InvalidInput,"開始局面の盤面情報が不足または重複しています。"));}
                    in_position=false;have_position=true;
                    let (initial,tokens,_)=rshogi_csa::parse_csa(&position_lines.join("\n")).map_err(|e|fail(format!("Invalid CSA Position: {e}")))?;
                    let board=initial.to_sfen();let board=board.split_whitespace().next().unwrap_or("");
                    if board.chars().filter(|c|*c=='K').count()!=1 || board.chars().filter(|c|*c=='k').count()!=1 {return Err(io::Error::new(io::ErrorKind::InvalidInput,"開始局面の玉の配置が不正です。"));}
                    initial_sfen=position_initial_sfen(&position_lines,&initial)?;pos=initial;pos.ply=initial_sfen.split_whitespace().last().and_then(|v|v.parse().ok()).ok_or_else(||fail("開始局面の手数が不正です"))?;moves.clear();opening_frames.clear();
                    if show_board && app_mode() {opening_frames.push(serde_json::json!({"sfen":initial_sfen,"ply":display_ply(&initial_sfen,0)}));}
                    for token in tokens {let usi=rshogi_csa::csa_move_to_usi(&token,&pos).map_err(|e|fail(e.to_string()))?;pos.apply_csa_move(&token).map_err(|e|fail(e.to_string()))?;moves.push(usi);if show_board && app_mode() {opening_frames.push(serde_json::json!({"sfen":pos.to_sfen(),"ply":display_ply(&initial_sfen,moves.len()),"move":moves.last()}));}}
                    continue;
                }
                if in_position {position_lines.push(line);continue;}
                if line=="END Game_Summary" {if !logged_in||!summary_open||!committed||summary_complete||!have_side||!have_position{return Err(io::Error::new(io::ErrorKind::InvalidInput,"対局情報が不足または不正なため、開始できません。"));}
                    let totals=[side_time[0].total.or(common_time.total),side_time[1].total.or(common_time.total)];
                    let totals=match totals {[Some(b),Some(w)]=>[b,w],_=>return Err(io::Error::new(io::ErrorKind::InvalidInput,"対局情報に持ち時間が不足しています。"))};
                    inc=[side_time[0].increment.or(common_time.increment).unwrap_or(0),side_time[1].increment.or(common_time.increment).unwrap_or(0)];
                    let byoyomi=[side_time[0].byoyomi.or(common_time.byoyomi).unwrap_or(0),side_time[1].byoyomi.or(common_time.byoyomi).unwrap_or(0)];
                    if byoyomi[0]!=byoyomi[1] {return Err(io::Error::new(io::ErrorKind::InvalidInput,"先後で異なる秒読みには対応していません。"));}byo=byoyomi[0];
                    if inc.iter().any(|v|*v>0)&&byo>0{return Err(io::Error::new(io::ErrorKind::InvalidInput,"秒読みと時間加算を併用する対局条件には対応していません。"));}
                    let opening=opening_clocks(&position_lines,totals)?;if opening.len()!=moves.len()+1{return Err(fail("開始局面の指し手と消費時間を読み取れません"));}clocks=opening.last().unwrap().0;for (frame,(clock,elapsed)) in opening_frames.iter_mut().zip(opening){frame["clocks"]=serde_json::json!(clock);frame["elapsed"]=serde_json::json!(elapsed);}if app_mode() && MATCH_GATE.load(std::sync::atomic::Ordering::Relaxed) {
                    app_event(serde_json::json!({"event":"match_found","game_id":game_id,"black":black,"white":white,"side":if side=='+' {"black"}else{"white"}}));
                    let replies=MATCH_REPLIES.get().ok_or_else(||fail("マッチングの確認に失敗しました"))?;
                    match tokio::time::timeout(Duration::from_secs(10), replies.lock().await.recv()).await { Ok(Some(()))=>{}, _=>return Err(fail("マッチングの確認がタイムアウトしました")) }
                }write.write_all(b"AGREE\n").await?;summary_open=false;summary_complete=true;prestart_timeout.as_mut().reset(tokio::time::Instant::now()+Duration::from_secs(30));console_progress(status,"対局条件を受け付けました。開始を待っています...");}
                if line.starts_with("START:") {
                    if !summary_complete||game_started{return Err(io::Error::new(io::ErrorKind::InvalidInput,"対局開始の受信順序が不正です。"));}game_started=true;*started=true;turn_started=std::time::Instant::now();
                    if game_id.is_empty() {game_id=line.trim_start_matches("START:").to_owned();}
                    if let Some(dir)=record_dir {record=Some(AsyncRecord::start(dir.to_path_buf(),game_id.clone(),black.clone(),white.clone(),position_lines.clone()));}
                    if show_board {if app_mode(){app_event(serde_json::json!({"event":"game_started","side":if side=='+' {"black"}else{"white"},"game_id":game_id,"board":format_board(&pos),"sfen":pos.to_sfen(),"ply":display_ply(&initial_sfen,moves.len()),"frames":opening_frames,"black":black,"white":white,"clocks":clocks,"increment":if inc[0]==inc[1]{Some(inc[0])}else{None},"increments":inc,"byoyomi":byo}));}else{println!("対局開始（{}）\n{}",if side=='+' {"先手"} else {"後手"},format_board(&pos));}}
                }
                if line.starts_with("START:") && (pos.side_to_move==rshogi_csa::Color::Black)==(side=='+') { go(engine,&initial_sfen,&moves,clocks,inc,byo,false).await?;thinking=true;analysis=Analysis::default();if app_mode(){app_event(serde_json::json!({"event":"search_state","mode":"thinking"}));} }
                if line.starts_with('+')||line.starts_with('-') {
                    if line.len()<7 {continue;}
                    if !game_started{return Err(io::Error::new(io::ErrorKind::InvalidInput,"対局開始前に指し手を受信しました。"));}
                    let token=line.split(',').next().unwrap();let usi=rshogi_csa::csa_move_to_usi(token,&pos).map_err(|e|fail(e.to_string()))?;
                    if let Some(r)=record.as_mut(){
                        // Some CSA servers omit the engine's comment in their echo.
                        // Preserve our own analysis, but never add a second comment.
                        if token.starts_with(side) && !line.contains(",'*") {
                            let comment=analysis.comment(&pos,side);
                            r.write_wire(&format!("{line}{comment}"));
                        }else{r.write_wire(&line);}
                    }
                    // A CSA wire comment describes the position before this move.
                    // Convert on a clone so malformed opponent PVs cannot affect play.
                    let mut wire_pv=Vec::<String>::new();
                    if show_board && app_mode() {if let Some(comment)=line.split(",'*").nth(1){let mut words=comment.split_whitespace();words.next();let mut pv_pos=pos.clone();for item in words.take(32){let Ok(pv_move)=rshogi_csa::csa_move_to_usi(item,&pv_pos) else{break};if pv_pos.apply_csa_move(item).is_err(){break;}wire_pv.push(pv_move);}}}
                    pos.apply_csa_move(token).map_err(|e|fail(e.to_string()))?;moves.push(usi);
                    let mover=usize::from(line.starts_with('-'));let elapsed=line.split(',').find_map(|s|s.strip_prefix('T')).and_then(|s|s.parse::<u64>().ok()).unwrap_or(0);
                    clocks[mover]=clocks[mover].saturating_add(inc[mover]).saturating_sub(elapsed);turn_started=std::time::Instant::now();
                    if show_board {if app_mode(){let evaluation=line.split(",'*").nth(1).and_then(|s|s.split_whitespace().next()).and_then(|s|s.parse::<i32>().ok());app_event(serde_json::json!({"event":"move","move":moves.last().unwrap(),"ply":display_ply(&initial_sfen,moves.len()),"sfen":pos.to_sfen(),"board":format_board(&pos),"clocks":clocks,"elapsed":elapsed,"evaluation":evaluation,"pv":wire_pv}));}else{println!("指し手: {}\n{}",moves.last().unwrap(),format_board(&pos));}}
                    if token.starts_with(if side=='+' {'-'} else {'+'}) {
                        analysis=Analysis::default();
                        if let Some(expected)=pondering.take() {
                            if expected==*moves.last().unwrap() {
                                engine.send("ponderhit").await?;thinking=true;analysis=std::mem::take(&mut ponder_analysis);if app_mode(){app_event(serde_json::json!({"event":"search_state","mode":"thinking"}));}
                            } else {
                                engine.send("stop").await?;ponder_stopping=true;ponder_stop_deadline=Some(tokio::time::Instant::now()+Duration::from_secs(10));if app_mode(){app_event(serde_json::json!({"event":"search_state","mode":"stopping"}));}
                            }
                        } else {
                            go(engine,&initial_sfen,&moves,clocks,inc,byo,false).await?;thinking=true;if app_mode(){app_event(serde_json::json!({"event":"search_state","mode":"thinking"}));}
                        }
                    } else if ponder_enabled {
                        if let Some(expected)=pending_ponder.take() {
                            // Ignore illegal or malformed predictions instead of sending an invalid position.
                            if valid_ponder_move(&pos, &expected) {
                                let mut ponder_moves=moves.clone();ponder_moves.push(expected.clone());
                                go(engine,&initial_sfen,&ponder_moves,clocks,inc,byo,true).await?;
                                let mut predicted=pos.clone();
                                ponder_sfen=rshogi_csa::usi_move_to_csa(&expected,&predicted).ok().and_then(|m|predicted.apply_csa_move(&m).ok()).map(|_|predicted.to_sfen()).unwrap_or_default();
                                ponder_analysis=Analysis::default();
                                if app_mode(){app_event(serde_json::json!({"event":"search_state","mode":"pondering","ponder_move":expected,"ponder_base_sfen":pos.to_sfen()}));}pondering=Some(expected);
                            }
                        }
                    }
                }
                if line.starts_with('%') {terminal_elapsed_ms=line.split(',').find_map(|s|s.strip_prefix('T')).and_then(|s|s.parse::<u64>().ok()).map(|v|v.saturating_mul(1000));}
                if line.starts_with('%') || line.starts_with('#') {if let Some(r)=record.as_mut(){r.write_wire(&line);}}
                if line.starts_with('#') && !["#WIN","#LOSE","#DRAW","#CENSORED"].contains(&line.as_str()) {termination_reason=line.clone();}
                if ["#WIN","#LOSE","#DRAW","#CENSORED"].contains(&line.as_str()) {
                    if !game_started{return Err(fail("対局開始前に中止されました。接続し直します。"));}
                    let elapsed=terminal_elapsed_ms.unwrap_or_else(||u64::try_from(turn_started.elapsed().as_millis()).unwrap_or(u64::MAX));
                    if status.is_none(){app_event(serde_json::json!({"event":"game_ending","reason":termination_reason,"terminal_elapsed_ms":elapsed}));}
                    if let Some(r)=record.take(){r.finish(&termination_reason,&line,side,&black,&white).await;}
                    if status.is_none(){app_event(serde_json::json!({"event":"game_finished","result":line,"reason":termination_reason,"terminal_elapsed_ms":elapsed}));}
                    console_progress(status, match line.as_str() {"#WIN"=>"対局終了: 勝ち", "#LOSE"=>"対局終了: 負け", "#DRAW"=>"対局終了: 引き分け", "#CENSORED" if termination_reason=="#MAX_MOVES"=>"対局終了: 引き分け（最大手数）", _=>"対局終了: 中断"});
                    if thinking || pondering.is_some() || ponder_stopping {
                        let send_stop=!ponder_stopping;
                        let deadline=ponder_stop_deadline.take().unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(10));
                        thinking=false;pondering=None;ponder_stopping=false;
                        stop_search(engine, send_stop, deadline).await?;
                    }
                    let aborted=line=="#CENSORED"&&termination_reason!="#MAX_MOVES";
                    if !aborted {engine.send(match line.as_str(){"#WIN"=>"gameover win","#LOSE"=>"gameover lose",_=>"gameover draw"}).await?;}
                    log_stderr(&format!("{name}: {line} ({} plies)",moves.len()));if drain.as_ref().is_some_and(|d| *d.borrow()) {let _=write.write_all(b"LOGOUT\n").await;console_progress(status,"ログアウト処理を行いました。");}if let Some(s)=status{s("completed");}return Ok(if aborted {PlayOutcome::Aborted}else{PlayOutcome::Completed});
                }
            }
            _=&mut prestart_timeout,if committed&&!game_started=>{return Err(io::Error::new(io::ErrorKind::TimedOut,"対局開始が30秒以内に通知されませんでした。"));}
            _=&mut login_timeout,if !logged_in=>{return Err(io::Error::new(io::ErrorKind::TimedOut,"ログイン応答が30秒以内に届きませんでした。"));}
            _=heartbeat.tick(),if logged_in=>{write.write_all(b"\n").await?;}
            _=async {
                if let Some(receiver)=drain.as_mut(){if !*receiver.borrow(){let _=receiver.changed().await;}}
                else{std::future::pending::<()>().await;}
            },if !committed=>{if drain.as_ref().is_some_and(|d| *d.borrow()){let _=write.write_all(b"LOGOUT\n").await;console_progress(status,"ログアウト処理を行いました。");if let Some(s)=status{s("drained");}return Ok(PlayOutcome::Drained);}}
            line=engine.lines.recv()=> {
                let line=line.ok_or_else(||fail("engine exited"))??;
                if ponder_stopping && line.starts_with("bestmove ") {
                    ponder_stopping=false;ponder_stop_deadline=None;
                    go(engine,&initial_sfen,&moves,clocks,inc,byo,false).await?;
                    thinking=true;analysis=Analysis::default();if app_mode(){app_event(serde_json::json!({"event":"search_state","mode":"thinking"}));}
                    continue;
                }
                if pondering.is_some() && line.starts_with("bestmove ") {
                    pondering=None;
                    return Err(io::Error::new(io::ErrorKind::InvalidInput,"先読み中にstopまたはponderhitより先にbestmoveを受信しました。"));
                }
                if pondering.is_some() && line.starts_with("info ") {
                    ponder_analysis.update(&line);
                    if app_mode() { emit_live_analysis(&line, "pondering", &ponder_sfen, side); }
                }
                if thinking { analysis.update(&line);
                    if app_mode() { emit_live_analysis(&line, "thinking", &pos.to_sfen(), side); }
                    if let Some(best)=line.strip_prefix("bestmove ").and_then(|s|s.split_whitespace().next()) {
                    thinking=false;if app_mode(){app_event(serde_json::json!({"event":"search_state","mode":"waiting"}));}
                    let words=line.split_whitespace().collect::<Vec<_>>();
                    pending_ponder=if ponder_enabled && words.get(2)==Some(&"ponder") { words.get(3).map(|v| (*v).to_string()) } else { None };
                    if best!="resign" && best!="win" { analysis=analysis.for_move(best); }
                    let token=match best {"resign"=>"%TORYO".to_string(),"win"=>"%KACHI".to_string(),_=>rshogi_csa::usi_move_to_csa(best,&pos).map_err(|e|fail(e.to_string()))?};
                    if show_board {if app_mode(){app_event(serde_json::json!({"event":"analysis","move":best,"score":analysis.display_score,"evaluation":analysis.score.map(|v|if side=='+'{v}else{v.saturating_neg()}),"pv":analysis.pv}));}else{println!("自分の指し手: {best}　評価値: {}　読み筋: {}",analysis.display_score.as_deref().unwrap_or("なし"),if analysis.pv.is_empty(){"なし".to_string()}else{analysis.pv.join(" ")});}}
                    let comment = if token.starts_with('%') { String::new() } else { analysis.comment(&pos, side) };
                    write.write_all(format!("{token}{comment}\n").as_bytes()).await?;
                }}
            }
        } }
    }.await;
    drop(reader_task);
    if thinking || pondering.is_some() || ponder_stopping {
        let deadline=ponder_stop_deadline.unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(10));
        stop_search(engine, !ponder_stopping, deadline).await?;
    }
    result
}

fn valid_ponder_move(position: &rshogi_csa::Position, expected: &str) -> bool {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(rshogi_core::bitboard::init_bitboard_tables);
    let mut position_core = rshogi_core::position::Position::new();
    if position_core.set_sfen(&position.to_sfen()).is_err() { return false; }
    let mut legal = rshogi_core::movegen::MoveList::new();
    rshogi_core::movegen::generate_legal_all(&position_core, &mut legal);
    legal.iter().any(|mv| mv.to_usi() == expected)
}

async fn stop_search(engine: &mut Engine, send_stop: bool, deadline: tokio::time::Instant) -> io::Result<()> {
    if send_stop { engine.send("stop").await?; }
    tokio::time::timeout_at(deadline, async {
        while let Some(line)=engine.lines.recv().await {
            if line?.starts_with("bestmove ") { return Ok(()); }
        }
        Err(io::Error::new(io::ErrorKind::InvalidInput,"探索停止中にエンジンが終了しました"))
    }).await.map_err(|_|io::Error::new(io::ErrorKind::InvalidInput,"探索停止後のbestmoveを10秒以内に受信できませんでした"))?
}
async fn go(
    engine: &mut Engine,
    initial_sfen: &str,
    moves: &[String],
    clocks: [u64; 2],
    inc: [u64; 2],
    byo: u64,
    ponder: bool,
) -> io::Result<()> {
    engine
        .send(&format!(
            "position {}{}",
            if initial_sfen == rshogi_core::position::SFEN_HIRATE {
                "startpos".to_string()
            } else {
                format!("sfen {initial_sfen}")
            },
            if moves.is_empty() {
                String::new()
            } else {
                format!(" moves {}", moves.join(" "))
            }
        ))
        .await?;
    let timing = if inc.iter().any(|v| *v > 0) {
        format!("binc {} winc {}", inc[0].saturating_mul(1000), inc[1].saturating_mul(1000))
    } else {
        format!("byoyomi {}", byo.saturating_mul(1000))
    };
    engine
        .send(&format!(
            "go {}btime {} wtime {} {timing}",
            if ponder { "ponder " } else { "" },
            clocks[0].saturating_mul(1000),
            clocks[1].saturating_mul(1000)
        ))
        .await
}

// YaneuraOu's default `d` display uses uppercase for Black, lowercase for
// White, and a leading '+' for promoted pieces.
fn format_board(position: &rshogi_csa::Position) -> String {
    use std::fmt::Write as _;
    let sfen = position.to_sfen();
    let fields: Vec<_> = sfen.split_whitespace().collect();
    let mut out = String::new();
    let _ = writeln!(out, " 9 8 7 6 5 4 3 2 1");
    if let Some(board) = fields.first() {
        for rank in board.split('/') {
            let mut promoted = false;
            for ch in rank.chars() {
                if ch == '+' {
                    promoted = true;
                } else if let Some(n) = ch.to_digit(10) {
                    for _ in 0..n { out.push_str(" ."); }
                } else {
                    out.push(if promoted { '+' } else { ' ' });
                    out.push(ch);
                    promoted = false;
                }
            }
            out.push('\n');
        }
    }
    let hand = fields.get(2).copied().unwrap_or("-");
    let (mut black, mut white, mut count) = (String::new(), String::new(), String::new());
    for ch in hand.chars() {
        if ch.is_ascii_digit() { count.push(ch); }
        else if ch.is_ascii_alphabetic() {
            let target = if ch.is_ascii_uppercase() { &mut black } else { &mut white };
            if !target.is_empty() { target.push(' '); }
            target.push_str(&count);
            target.push(ch);
            count.clear();
        }
    }
    let _ = writeln!(out, "先手 手駒: {}　後手 手駒: {}", if black.is_empty() { "なし" } else { &black }, if white.is_empty() { "なし" } else { &white });
    let _ = writeln!(out, "手番: {}", if position.side_to_move == rshogi_csa::Color::Black { "先手" } else { "後手" });
    let _ = write!(out, "sfen {sfen}");
    out
}

// Each PV line is a separate snapshot; do not combine bounds or values from
// earlier lines, nor display informational lines without a principal variation.
fn emit_live_analysis(line: &str, mode: &str, sfen: &str, side: char) {
    if line == "info string" || line.starts_with("info string ") {
        app_event(serde_json::json!({"event":"search_string","mode":mode,"sfen":sfen,"message":line}));
        return;
    }
    if !line.starts_with("info ") { return; }
    let fields: Vec<_> = line.split_whitespace().collect();
    let number = |name| fields.iter().position(|v| *v == name).and_then(|i| fields.get(i + 1)).and_then(|v| v.parse::<u64>().ok());
    let nodes = number("nodes");
    let nps = number("nps");
    let hashfull = number("hashfull").filter(|value| *value <= 1000);
    if nodes.is_some() || nps.is_some() || hashfull.is_some() { app_event(serde_json::json!({"event":"search_metrics","nodes":nodes,"nps":nps,"hashfull":hashfull})); }
    if !fields.contains(&"pv") { return; }
    let mut live = Analysis::default();
    live.update_info(line, false);
    if live.pv.is_empty() { return; }
    let primary = !fields.windows(2).any(|v| v[0] == "multipv" && v[1] != "1");
    app_event(serde_json::json!({"event":"analysis_update","primary":primary,"mode":mode,"depth":live.depth,"seldepth":live.seldepth,"time_ms":number("time"),"nodes":nodes,"nps":nps,"bound":live.bound,"sfen":sfen,"score":live.display_score,"evaluation":live.score.map(|v|if side=='+'{v}else{v.saturating_neg()}),"pv":live.pv}));
}

#[derive(Clone, Default)]
struct Candidate { score: Option<i32>, display_score: Option<String>, pv: Vec<String> }
#[derive(Default)]
struct Analysis {
    depth: Option<u32>,
    seldepth: Option<u32>,
    nps: Option<u64>,
    bound: Option<&'static str>,
    score: Option<i32>,
    pv: Vec<String>,
    display_score: Option<String>,
    candidates: std::collections::HashMap<String, Candidate>,
    pending_parts: std::collections::HashMap<(u32, u32), Candidate>,
}
impl Analysis {
    fn update(&mut self, line: &str) {
        self.update_info(line, true);
        let mut snapshot=Analysis::default();snapshot.update_info(line,false);
        let fields:Vec<_>=line.split_whitespace().collect();
        let multipv=fields.iter().position(|v|*v=="multipv").map(|i|fields.get(i+1).and_then(|v|v.parse::<u32>().ok())).unwrap_or(Some(1));
        // Pair split messages only when both identify the same depth and
        // MultiPV slot; unrelated or ambiguous updates must not share scores.
        if (snapshot.score.is_some() || !snapshot.pv.is_empty()) && (snapshot.depth.is_none() || multipv.is_none()) {self.pending_parts.clear();}
        if let (Some(depth),Some(slot))=(snapshot.depth,multipv) {
            if snapshot.score.is_some() || !snapshot.pv.is_empty(){self.pending_parts.retain(|(d,n),_|*n!=slot||*d==depth);}
            if snapshot.score.is_some() != !snapshot.pv.is_empty() {
                let partial=Candidate{score:snapshot.score,display_score:snapshot.display_score.clone(),pv:snapshot.pv.clone()};
                if let Some(previous)=self.pending_parts.remove(&(depth,slot)) {
                    if previous.score.is_some()!=partial.score.is_some() {
                        let (score,pv)=if partial.score.is_some(){(partial,previous)}else{(previous,partial)};
                        if let Some(first)=pv.pv.first(){self.candidates.insert(first.clone(),Candidate{score:score.score,display_score:score.display_score,pv:pv.pv});}
                    } else {self.pending_parts.insert((depth,slot),partial);}
                } else {self.pending_parts.insert((depth,slot),partial);}
                if self.pending_parts.len()>512 {self.pending_parts.clear();}
            } else if snapshot.score.is_some() && !snapshot.pv.is_empty() {self.pending_parts.remove(&(depth,slot));}
        }
        if let Some(first)=snapshot.pv.first() {
            if snapshot.score.is_some() {
                self.candidates.insert(first.clone(),Candidate{score:snapshot.score,display_score:snapshot.display_score,pv:snapshot.pv});
            } else if let Some(candidate)=self.candidates.get_mut(first) { candidate.pv=snapshot.pv; }
        }
    }
    fn for_move(self, best: &str) -> Self {
        if let Some(candidate)=self.candidates.get(best) {
            let mut selected=Self::default();selected.score=candidate.score;selected.display_score=candidate.display_score.clone();selected.pv=candidate.pv.clone();return selected;
        }
        let mut selected=Self::default();
        if self.pv.first().is_some_and(|m|m==best) {selected.pv=self.pv;}
        selected
    }
    fn update_info(&mut self, line: &str, primary_only: bool) {
        if !line.starts_with("info ") {
            return;
        }
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.get(1) == Some(&"string") {
            return;
        }
        // Bounds are valid search output too. Dropping an entire bound-only
        // info line loses both the score and PV when no exact line precedes
        // bestmove (e.g. with PvInterval suppressing intermediate output).
        if primary_only && fields.windows(2).any(|v| v[0] == "multipv" && v[1] != "1") {
            return;
        }
        if let Some(i) = fields.iter().position(|v| *v == "depth") {
            if let Some(depth) = fields.get(i + 1).and_then(|v| v.parse().ok()) { self.depth = Some(depth); }
        }
        if let Some(i) = fields.iter().position(|v| *v == "seldepth") {
            if let Some(value) = fields.get(i + 1).and_then(|v| v.parse().ok()) { self.seldepth = Some(value); }
        }
        if let Some(i) = fields.iter().position(|v| *v == "nps") {
            if let Some(value) = fields.get(i + 1).and_then(|v| v.parse().ok()) { self.nps = Some(value); }
        }
        if let Some(i) = fields.iter().position(|v| *v == "score") {
            self.bound = match fields.get(i + 3).copied() { Some("lowerbound") => Some("--"), Some("upperbound") => Some("++"), _ => None };
            if let (Some(kind), Some(value)) = (fields.get(i + 1), fields.get(i + 2)) {
                let parsed = value.parse::<i32>().ok().or_else(|| {
                    if *kind == "mate" {
                        match *value {
                            "+" => Some(1),
                            "-" => Some(-1),
                            _ => None,
                        }
                    } else {
                        None
                    }
                });
                if let Some(value) = parsed {
                    self.display_score = Some(if *kind == "mate" { format!("詰み {}", fields[i + 2]) } else { value.to_string() });
                    self.score = match *kind {
                        "cp" => Some(value),
                        "mate" => Some(if value >= 0 { 100000 } else { -100000 }),
                        _ => None,
                    };
                }
            }
        }
        if let Some(i) = fields.iter().position(|v| *v == "pv") {
            self.pv = fields[i + 1..]
                .iter()
                .take(32)
                .map(|v| v.to_string())
                .collect();
        }
    }
    fn comment(&self, position: &rshogi_csa::Position, side: char) -> String {
        if self.score.is_none() && self.pv.is_empty() {
            return String::new();
        }
        let score = self
            .score
            .map(|score| {
                if side == '+' {
                    score
                } else {
                    score.saturating_neg()
                }
            })
            .map(|score| score.to_string())
            .unwrap_or_else(|| "pv".into());
        let mut position = position.clone();
        let mut moves = Vec::new();
        for usi in &self.pv {
            let Ok(token) = rshogi_csa::usi_move_to_csa(usi, &position) else {
                break;
            };
            if position.apply_csa_move(&token).is_err() {
                break;
            }
            moves.push(token);
        }
        format!(
            ",'* {score}{}",
            if moves.is_empty() {
                String::new()
            } else {
                format!(" {}", moves.join(" "))
            }
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csa_position_comment_preserves_initial_sfen_move_number() {
        let lines = ["'ShogiZone_Initial_Ply:24", "PI", "+", "+7776FU", "T0"]
            .map(str::to_owned)
            .to_vec();
        let (initial, moves, _) = rshogi_csa::parse_csa(&lines.join("\n")).unwrap();
        assert_eq!(moves, ["+7776FU"]);
        assert_eq!(
            position_initial_sfen(&lines, &initial).unwrap(),
            rshogi_core::position::SFEN_HIRATE.replace(" 1", " 24")
        );
        assert_eq!(
            position_initial_sfen(&["PI".into(), "+".into()], &initial).unwrap(),
            rshogi_core::position::SFEN_HIRATE
        );
        assert!(position_initial_sfen(&["'ShogiZone_Initial_Ply:0".into()], &initial).is_err());
        assert!(
            position_initial_sfen(
                &[
                    "'ShogiZone_Initial_Ply:24".into(),
                    "'ShogiZone_Initial_Ply:25".into()
                ],
                &initial
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn line_limits_apply_before_newline_and_preserve_fragmented_crlf() {
        let (mut writer, reader) = tokio::io::duplex(3);
        let writer = tokio::spawn(async move {
            writer.write_all(b"usiok\r\nreadyok\nlast").await.unwrap();
        });
        let mut reader = BufReader::new(reader);
        for expected in ["usiok", "readyok", "last"] {
            assert_eq!(
                bounded_line(&mut reader, 16, "USI")
                    .await
                    .unwrap()
                    .as_deref(),
                Some(expected)
            );
        }
        assert!(
            bounded_line(&mut reader, 16, "USI")
                .await
                .unwrap()
                .is_none()
        );
        writer.await.unwrap();
        let bytes = vec![b'x'; 16385];
        let mut reader = BufReader::new(bytes.as_slice());
        let error = bounded_line(&mut reader, 16384, "USI").await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("16384"));
        let mut reader = BufReader::new(&b"\xff\n"[..]);
        assert!(
            bounded_line(&mut reader, 16, "USI")
                .await
                .unwrap_err()
                .to_string()
                .contains("UTF-8")
        );
    }
    #[tokio::test]
    async fn legacy_engine_diagnostics_do_not_corrupt_protocol_commands() {
        for (source, bytes, accepted) in [
            ("USI", &b"info string \x82\xa0\n"[..], true),
            ("USI", &b"id name \x82\xa0\n"[..], true),
            ("USI", &b"bestmove \x82\xa0\n"[..], false),
            ("CSA", &b"info string \x82\xa0\n"[..], false),
        ] {
            let mut reader=BufReader::new(bytes);
            let result=bounded_line(&mut reader,128,source).await;
            if accepted {assert!(result.unwrap().unwrap().contains('\u{fffd}'));}
            else {assert_eq!(result.unwrap_err().kind(),io::ErrorKind::InvalidData);}
        }
    }
    #[tokio::test]
    async fn receive_queue_propagates_line_errors_without_truncating_commands() {
        let (tx, mut rx) = mpsc::channel(8);
        forward_lines(
            BufReader::new(&b"usiok\n123456789\nbestmove 7g7f\n"[..]),
            tx,
            8,
            "USI",
        )
        .await;
        assert_eq!(rx.recv().await.unwrap().unwrap(), "usiok");
        assert_eq!(
            rx.recv().await.unwrap().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(rx.recv().await.is_none());
        let mut a = Analysis::default();
        a.update(&format!(
            "info score cp 12 pv {}",
            vec!["7g7f"; 1000].join(" ")
        ));
        assert_eq!(a.pv.len(), 32);
        assert_eq!(a.score, Some(12));
    }
    #[test]
    fn info_is_converted_to_black_perspective_and_sequential_csa_pv() {
        let mut a = Analysis::default();
        a.update("info depth 10 score cp 120 pv 7g7f 3c3d");
        assert_eq!(
            a.comment(&rshogi_csa::initial_position(), '+'),
            ",'* 120 +7776FU -3334FU"
        );
        let mut p = rshogi_csa::initial_position();
        p.apply_csa_move("+7776FU").unwrap();
        a.update("info depth 11 score cp 90 pv 3c3d 2g2f");
        assert_eq!(a.comment(&p, '-'), ",'* -90 -3334FU +2726FU");
        a.update("info multipv 2 score cp 999 pv 8c8d");
        assert_eq!(a.score, Some(90));
        a.update("info score cp 888 lowerbound pv 8c8d");
        assert_eq!(a.score, Some(888));
        a.update("info string score cp 999");
        assert_eq!(a.score, Some(888));
        a = Analysis::default();
        a.update("info depth 2 pv 7g7f 3c3d");
        assert_eq!(
            a.comment(&rshogi_csa::initial_position(), '+'),
            ",'* pv +7776FU -3334FU"
        );
        a.update("info score mate -");
        assert_eq!(a.score, Some(-100000));
    }
    #[test]
    fn bound_only_info_keeps_primary_score_and_pv() {
        for bound in ["lowerbound", "upperbound"] {
            let mut a = Analysis::default();
            a.update(&format!(
                "info depth 18 score cp -37 {bound} multipv 1 pv 7g7f 8c8d"
            ));
            assert_eq!(
                a.comment(&rshogi_csa::initial_position(), '+'),
                ",'* -37 +7776FU -8384FU"
            );
            assert_eq!(
                a.comment(&rshogi_csa::initial_position(), '-'),
                ",'* 37 +7776FU -8384FU"
            );
            a.update("info depth 19 multipv 2 score cp 999 pv 2g2f");
            a.update("info string lowerbound score cp 123 pv 2g2f");
            a.update("info nodes 1000 nps 2000");
            assert_eq!(
                a.comment(&rshogi_csa::initial_position(), '+'),
                ",'* -37 +7776FU -8384FU"
            );
            a.update("info depth 19 score cp 42 pv 2g2f");
            assert_eq!(
                a.comment(&rshogi_csa::initial_position(), '+'),
                ",'* 42 +2726FU"
            );
        }
    }
}
