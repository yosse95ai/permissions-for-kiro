import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { PermissionsTreeDataProvider, VIEW_ID } from './tree';
import { watchPermissions } from './watch';

/**
 * 拡張のエントリポイント。
 *
 * 引数を `Pick<..., 'subscriptions'>` に絞っているのは、**この関数が実際に使うのは
 * `subscriptions` だけ**で、テストからダミーを渡せるようにするため。VS Code は完全な
 * `ExtensionContext` を渡すので、構造的部分型により問題なく受け取れる。
 */
export function activate(context: Pick<vscode.ExtensionContext, 'subscriptions'>): void {
  const provider = new PermissionsTreeDataProvider();

  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    view,
    provider,
    ...registerCommands(provider),
    ...watchPermissions(() => {
      provider.refresh();
    }),
  );
}

export function deactivate(): void {
  // 解放すべきリソースは `context.subscriptions` に登録しているため、ここでは何もしない。
}
