import type * as vscode from 'vscode';

/**
 * 拡張のエントリポイント。
 *
 * フェーズ 4 で `TreeDataProvider` の登録、フェーズ 5 でコマンドの登録、
 * フェーズ 6 で `FileSystemWatcher` の設定を追加する。
 */
export function activate(_context: vscode.ExtensionContext): void {
  // 現時点では何もしない（フェーズ 2 のビルド検証用のスケルトン）。
}

export function deactivate(): void {
  // 解放すべきリソースは `context.subscriptions` に登録するため、ここでは何もしない。
}
