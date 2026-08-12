# Permissions for Kiro

サイドバーに `PERMISSIONS` ビューを追加し、現在のワークスペースとユーザープロファイルに効いている権限ルールをツリー表示します。ルールをクリックすると、それを定義しているファイルの該当行にジャンプします。

> [!IMPORTANT]
> これは個人が開発している非公式の拡張機能であり、Amazon Web Services, Inc. の公式製品ではありません。AWS による保証・サポートはありません。
> Kiro は Amazon.com, Inc. またはその関連会社の商標です。

## 解決する課題

Kiro の権限設定ファイルは、ワークスペース内ではなくホームディレクトリ配下のハッシュ付きパスに保存されます。

```
~/.kiro/settings/permissions.yaml                  # User スコープ
~/.kiro/workspace-roots/<16 桁のハッシュ>/permissions.yaml   # Workspace スコープ
```

ハッシュはワークスペースの絶対パスから計算されるため、どのディレクトリが自分のワークスペースに対応するのかを目で追うことができません。この拡張はその対応を解決し、実際に効いているルールを一覧します。

## 機能

<!-- TODO: フェーズ 10-1 で記述する -->

- Workspace スコープ（ワークスペースルートごと）と User スコープのルールをツリー表示
- capability / effect / match パターンの 3 段構成
- ルールやパターンをクリックして定義行へジャンプ
- ペンシルアイコンから設定ファイルを開く（存在しない場合は作成）
- 設定ファイルの変更を検知して自動で再読み込み
- YAML のパースエラーを表示

## インストール

<!-- TODO: フェーズ 10-1 / 11 で記述する（Open VSX / VSIX の手順） -->

## 使い方

<!-- TODO: フェーズ 10-1 で記述する（スクリーンショットを含む） -->

## 対応環境

| 項目 | 対応                                    |
| ---- | --------------------------------------- |
| OS   | macOS / Windows                         |
| Kiro | <!-- TODO: 検証したバージョンを記載 --> |

## 開発

```bash
bun install       # 依存関係の取得
bun run build     # dist/extension.js を生成
bun run watch     # 変更を監視してビルド
bun run typecheck # 型チェック
bun run lint      # oxlint（type-aware 有効）
bun run test      # vitest
bun run package   # VSIX の生成
```

## ライセンス

[MIT](./LICENSE)

## 商標について

Kiro および AWS は Amazon.com, Inc. またはその関連会社の商標です。この拡張機能は Amazon Web Services, Inc. と提携しておらず、同社による推奨も受けていません。
