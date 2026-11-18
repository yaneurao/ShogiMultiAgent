# チュートリアル 5/5：ソースからビルドする

このページは、配布済みのアプリではなく、ソースコードから Windows x64 版を作る方向けです。以下は **Linux 上で Windows 版をクロスビルドする手順**です。配布フォルダを用意済みなら、[1/5：準備する](../tutorial.md) に進んでください。

## 1. ビルド環境を用意する

Linux 環境に次のものを用意します。

- Node.js 22 以上と npm
- Rust（edition 2024 対応）と Cargo
- MinGW（Windows x64 向け）
- Wine（Windows 実行ファイルにアイコンを設定するため）

依存関係の取得にはインターネット接続が必要です。Windows で直接ビルドする手順は、このプロジェクトでは用意していません。

## 2. プロジェクトを用意する

リポジトリを取得し、ターミナルで `package.json` のあるリポジトリ直下に移動します。そこで Rust の Windows ターゲットを追加し、Node.js の依存関係をインストールします。

```sh
rustup target add x86_64-pc-windows-gnu
npm ci
```

## 3. ビルドする

同じディレクトリで次を実行します。

```sh
./scripts/build-windows.sh
```

完了すると、`target/apps/shogimultiagent/ShogiMultiAgent-win32-x64/` に配布フォルダが作られます。このフォルダを Windows に移し、フォルダ内の `ShogiMultiAgent.exe` を起動してください。実行ファイルだけでなく、フォルダ全体が必要です。

詳しい開発・テスト手順は [開発・検証・ビルド](../../spec/development.md) を参照してください。クロスビルド後は Windows 上での動作も確認してください。

[← 前へ：4/5 棋譜を確認する](04-records.md) ｜ [最初へ：1/5 準備する](../tutorial.md) ｜ [トップページ](../../README.md)
