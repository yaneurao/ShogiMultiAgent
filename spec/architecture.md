# 構成とデータの流れ

## プロセス

~~~text
Electron 画面 ── preload / IPC ── Electron main
                                    │ 接続ごとに1プロセス
                                    ▼
                               Rust アダプター ── CSA/TCP ── 対局サーバー
                                    │ USI/標準入出力
                                    ▼
                               USI エンジン
~~~

- app/main.js：接続設定の保存、アダプターの起動と終了、イベント集約、対局履歴・ファイルの操作。
- app/preload.js：画面に公開する IPC の窓口。画面は Node.js を直接使わない。
- app/index.html、renderer.js、style.css、sprites.css：画面、一覧、将棋盤、棋譜とグラフ。
- adapter/：Rust アダプターの独立した Cargo 定義と実行ファイルの入口。実装は adapter/src/usi_agent.rs。
- app/assets/：このアプリに同梱するアイコン、盤、駒画像。外部サーバーから実行時に取得しない。

Electron の contextIsolation と sandbox を有効にし、renderer の nodeIntegration は無効にしている。ファイルやプロセスを操作する機能を追加するときは、preload を経由し、main 側で引数を検証する。

## 接続と表示

接続設定ごとにアダプターを起動し、各アダプターがエンジンを１つ起動する。設定の二重起動は、起動準備中を含めて main でも防ぐ。接続の状態はセッションごとに保持する。画面の「接続の詳細」のタブはセッションに対応し、状態や思考情報が他の接続へ混ざらないようにする。

アダプターはアプリモードの標準入力で設定を受け取り、標準出力に JSON Lines 形式のイベントを送る。app/main.js の eventFor がセッションに反映し、renderer は IPC 経由で状態を取得する。対局局面は履歴のフレームとして保存し、現在の思考・先読み情報はセッションの一時状態として扱う。履歴の再生位置を変えても現在の探索情報とは混同しない。

## 永続データ

Windows では接続設定を %APPDATA%/shogizone-participant/connections.json、履歴を同じフォルダの game-history/ に保存する。棋譜保存先を指定しない場合は %USERPROFILE%/Documents/ShogiMultiAgent/kif。これらの場所は既存ユーザーのデータを引き継ぐために維持している。変更するときは明示的な移行手段を用意する。

trip は Electron safeStorage で暗号化して設定に保存し、アダプターには標準入力で渡す。コマンドライン引数やログに平文を出さない。暗号化は保存時の保護であり、CSA の通信自体を暗号化するものではない。

対局中は game-history/pending/ に復旧用データを順次記録する。異常終了後の再起動時に保存済みの局面までを結果不明として復旧するが、未書き込みの最新情報は復元できない。CSA ファイルと画面の履歴は別物であり、削除画面ではそれぞれを独立して選べる。

## 独立性

このリポジトリはサーバーの実装を参照せず、CSA プロトコルで接続する。adapter/src/usi_agent.rs は別プロジェクトにも同じ由来の独立コピーがあるが、ビルドにそのプロジェクトは不要。共通由来のバグを修正する際は、保守者が必要に応じてもう一方への適用を検討する。
