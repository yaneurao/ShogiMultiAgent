# 開発・検証・ビルド

## 必要な環境

Node.js 22 以上、npm、Rust（edition 2024 対応）、Python 3 を使用する。Cargo の依存関係は adapter/Cargo.lock、Node.js の依存関係は package-lock.json で固定する。rshogi は Cargo.toml に記載された Git リビジョンから取得する。

最初にリポジトリ直下で次を実行する。

~~~sh
npm ci
cargo build --locked --manifest-path adapter/Cargo.toml --target-dir target
~~~

Linux で Electron を開発起動する場合、app/main.js は agent/usi-agent を起動するため、ビルドしたアダプターをそこに配置する。

~~~sh
mkdir -p agent
cp target/debug/shogizone-participant-agent agent/usi-agent
npm start
~~~

Linux 起動は開発・検証用であり、配布対象としている環境は Windows x64。agent/、target/、node_modules/ は生成物で、Git には含めない。

## テスト

基本テストはリポジトリ直下から実行する。CI は Rust の単体テスト、アダプターのビルドと一部の通信テストを実行する。

~~~sh
cargo test --locked --manifest-path adapter/Cargo.toml --target-dir target
cargo build --locked --manifest-path adapter/Cargo.toml --target-dir target
python3 tests/usi_agent_ponder_e2e.py
python3 tests/usi_agent_ponder_live_e2e.py
python3 tests/usi_agent_live_e2e.py
python3 tests/usi_agent_ponder_timeout_e2e.py
python3 tests/usi_agent_abort_restart_e2e.py
python3 tests/usi_agent_record_failure_e2e.py
python3 tests/usi_agent_busy_keepalive_e2e.py
python3 tests/usi_agent_reconnect_opening_e2e.py
python3 tests/usi_agent_asymmetric_time_e2e.py
python3 tests/usi_agent_selected_multipv_e2e.py
python3 tests/usi_agent_position_validation_e2e.py
python3 tests/usi_agent_slow_record_e2e.py
~~~

これらの通信テストはローカルの模擬 CSA サーバーと模擬 USI エンジンを使い、公開サーバーに対局を投入しない。先読みの命中・読み外し・停止・切断・連続対局や、探索情報の通知を検証する。tests/ のほかの usi_agent_*_e2e.py も、変更箇所に応じて実行する。タイムアウトを検証するテストには待ち時間がある。

participant_*_e2e.cjs は実際の Electron と Playwright を使う画面テスト。Playwright はアプリの実行時依存ではないため、検証環境に別途用意し、必要なら PLAYWRIGHT_MODULE にそのモジュールのパスを指定する。Linux のヘッドレス環境では Xvfb と、Electron が必要とするシステムライブラリも必要。上記の agent/usi-agent を先に配置する。

~~~sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright xvfb-run -a node tests/participant_app_e2e.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright xvfb-run -a node tests/participant_live_search_e2e.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright xvfb-run -a node tests/participant_record_failure_e2e.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright xvfb-run -a node tests/participant_finish_recovery_e2e.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright xvfb-run -a node tests/participant_interrupted_result_e2e.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright xvfb-run -a node tests/participant_partial_deletion_e2e.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright xvfb-run -a node tests/participant_live_recovery_e2e.cjs
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright xvfb-run -a node tests/participant_final_clock_e2e.cjs
~~~

非同期の条件を待つ画面テストでは tests/wait_for_async.cjs を使う。Playwright の waitForFunction に async 関数を渡すと Promise 自体が真となり、false でも待たずに完了するため使わない。

画面の変更では、接続ごとの情報の分離、横幅を変えた表示、ボタンの有効・無効、エラー表示位置を確認する。通信変更では、先後両方、先読み命中・外れ、終局・切断、終了予約と連続対局を確認する。模擬相手での成功だけで、すべての実エンジン・CSA サーバーとの互換性が保証されるわけではない。

## バージョン番号

アプリ画面のバージョンは `1.0.001` のように末尾を3桁で表示する。`package.json` と `package-lock.json` は npm の形式に従って `1.0.1` とし、画面表示時にゼロ埋めする。リリースごとにリポジトリ直下で `npm version patch --no-git-tag-version` を実行し、末尾を1ずつ増やす（例：`1.0.001` → `1.0.002`）。ビルドし直す前に両ファイルが更新されたことを確認する。

## Windows x64 のビルド

アプリを更新したら Windows x64 版もビルドし、出力先を更新する。既存の実行ファイルが使用中で置き換えられない場合は別フォルダに出力し、利用者にその場所を知らせる。配布 ZIP は明示的な依頼がない限り作らない。

Linux からのクロスビルドには、Rust の x86_64-pc-windows-gnu ターゲット、MinGW、Wine、Node.js 22 以上を用意する。Wine は Windows 実行ファイルへのアイコン設定に必要。

~~~sh
rustup target add x86_64-pc-windows-gnu
npm ci
./scripts/build-windows.sh
~~~

ビルドスクリプトは Rust アダプターをビルドし、agent/usi-agent3.exe に配置してから Electron をパッケージ化する。アプリはその名前を参照するため、変更時は app/main.js と scripts/build-windows.sh の両方を更新する。出力は target/apps/shogimultiagent/ShogiMultiAgent-win32-x64/。実行ファイルだけでは動かないため、配布時はフォルダ全体が必要。

既存の実行ファイルが使用中で上書きできない場合は、稼働中のものを壊さず、別名・別フォルダへ出力する。配布 ZIP は明示的に求められない限り作らない。公開前には Windows 上で実際に起動し、エンジン参加・先読み・終了予約・棋譜保存を確認する。クロスビルドの成功だけでは Windows 上の動作を保証しない。

## 保守時の注意

- ユーザーの設定・履歴・棋譜と、ビルド生成物を混同しない。削除や保存場所の変更には互換性を考慮する。
- trip やユーザーの接続設定、実際の棋譜をテストデータとしてコミットしない。
- 他サーバーのソースや非公開環境に依存せず、模擬相手で再現できるテストを優先する。
- 機能を変更したら README と spec/ の該当箇所も更新する。サーバー側とは独立してコミット・配布する。

## UIのツールチップ

画面に見えている内容をそのまま繰り返すだけのツールチップを付けない。複数の列の値を区切りなく連結して表示することも禁止する。ツールチップは操作の意味など画面上で得られない情報がある場合に限り、省略された内容を確認できるようにする場合は読み取れる形で提供する。
