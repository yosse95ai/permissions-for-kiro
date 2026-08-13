# Permissions for Kiro

[![CI](https://github.com/yosse95ai/permissions-for-kiro/actions/workflows/ci.yml/badge.svg)](https://github.com/yosse95ai/permissions-for-kiro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md) | **日本語**

サイドバーに `PERMISSIONS` ビューを追加し、現在のワークスペースとユーザープロファイルに効いている権限ルールを表示します。ルールをクリックすると、それを定義しているファイルの該当行にジャンプします。

![ツリーを展開し、パターンを定義している行へジャンプする](docs/images/demo.gif)

> [!IMPORTANT]
> **非公式の拡張機能です。** 個人が開発しているものであり、Amazon Web Services, Inc. の公式製品ではありません。AWS による保証・サポートはありません。
> Kiro は Amazon.com, Inc. またはその関連会社の商標です。

## 解決する課題

Kiro は権限を capability ごとに宣言し、match パターンと effect で指定します。仕組みそのものについては Kiro のドキュメントの [Permissions](https://kiro.dev/docs/permissions/) を参照してください。この拡張が扱うのは、そのルールがどこに置かれているか、そして実際に適用されているかどうかです。

Kiro は権限設定をワークスペース内に置きません。ホームディレクトリ配下の、ワークスペースのパスから計算したハッシュ名のディレクトリに保存します。

```
~/.kiro/settings/permissions.yaml                     # User スコープ
~/.kiro/workspace-roots/<16 桁のハッシュ>/permissions.yaml   # Workspace スコープ
```

ハッシュはワークスペースルートの絶対パスから導かれるため、どのディレクトリが自分のワークスペースに対応するのかを目で追う手段が実質ありません。この拡張はその対応を解決します。

さらに重要なのは、**ファイルの内容ではなく実際に効いているルールを表示する**ことです。Kiro は読み取れないルールを黙って捨てますし、場合によっては設定全体を捨てて fail closed になります。ファイルに書かれたままを見せると嘘になるため、このビューは Kiro 自身のローダーがどう扱うかを反映します。

## 機能

- ワークスペースルートごとのルールと、ユーザープロファイルのルールを一覧表示
- スコープ、ルール（capability と effect）、`match` / `exclude` の各パターンという 3 段構成
- 末端の行をクリックすると、それを定義している行にジャンプ
- ペンシルアイコンで設定ファイルを開く（存在しない場合は作成）
- 設定ファイルの変更を検知して自動で再読み込み（エディタ外からの編集も含む）
- **Kiro が読み飛ばすルールに印を付ける**（未知の capability など）。ルールが効いていない理由が分かります
- **設定全体の読み込みに失敗している場合は警告を出す**（fail closed。この状態ではどのルールも適用されません）
- YAML / JSON のパースエラーを、原因の行とともに表示
- `permissions.yaml` に加えて `permissions.json` に対応。マルチルートワークスペースにも対応

## インストール

Kiro の拡張ギャラリーは [Open VSX](https://open-vsx.org) を指しています。拡張ビューを開いて `Permissions for Kiro` を検索し、インストールしてください。

公開ページは [yosse95ai.permissions-for-kiro](https://open-vsx.org/extension/yosse95ai/permissions-for-kiro) です。

## 使い方

アクティビティバーで Kiro のビューコンテナを開きます。`PERMISSIONS` ビューは `MCP SERVERS` の下に出ます。

- **子を持つ行**は展開・折りたたみのみ。子を持たない行はクリックで定義行へジャンプします
- **`all` と表示されるルール**は `match` パターンを持たず、その capability の全対象に適用されます。クリックするとルール自体の行へジャンプします
- **`deny` と `ask` は明示的に併記します。** `allow` は一覧を読みやすく保つため無標にしています
- **スコープ行にマウスを乗せる**と、ワークスペースのフォルダと解決された設定ファイルのパスの両方を確認できます

このビューは読み取り専用です。ルールの追加・変更・削除はファイルを編集して行ってください。ファイルはペンシルアイコン、または任意の行のクリックから開けます。ルールの書き方は Kiro のドキュメントの [Permissions](https://kiro.dev/docs/permissions/) を参照してください。

## 動作環境

| 項目     | 対応                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| エディタ | **Kiro 専用。** Kiro の権限モデルに依存しているため、素の VS Code では動作しません |
| Kiro     | 1.0.288 以降で動作を確認                                                           |
| OS       | macOS / Windows（いずれも実機で検証済み）                                          |

## しくみ

この拡張は Kiro 本体から 2 つの挙動を再現しています。ワークスペースのパスを正規化してハッシュ化し設定ディレクトリを特定する処理と、ルールの検証処理です。これによって、ファイルそのままではなく実際に効いているルールを表示できています。

どちらも Kiro の内部実装に合わせているため、**将来 Kiro 側が変わると表示が実態と食い違う可能性があります。** 食い違いに気づいたら [Issue](https://github.com/yosse95ai/permissions-for-kiro/issues) を立ててください。

## 開発

[English README の Development 節](./README.md#development)を参照してください。

## コントリビュート

Issue も Pull Request も歓迎します。開発環境の準備と、コードを変更する前に知っておきたい制約は [CONTRIBUTING.md](./CONTRIBUTING.md)（英語）にまとめてあります。[Code of Conduct](./CODE_OF_CONDUCT.md)（英語）にも目を通してください。

**特に有用なのは食い違いの報告です。** この拡張は Kiro の内部実装を再現しており、Kiro 側は独自に更新されるため、ビューの表示と Kiro の実際の挙動が食い違うことがあります。見た目が壊れていなくても報告する価値があります。

セキュリティに関わる内容は、公開の Issue ではなく [非公開の報告](./SECURITY.md) を使ってください。

## ライセンス

[MIT](./LICENSE)

## 商標について

Kiro および AWS は Amazon.com, Inc. またはその関連会社の商標です。この拡張機能は Amazon Web Services, Inc. と提携しておらず、同社による推奨も受けていません。
