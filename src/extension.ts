import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { PermissionsTreeDataProvider, VIEW_ID } from './tree';
import { watchPermissions } from './watch';

/** 拡張のエントリポイント。 */
export function activate(context: vscode.ExtensionContext): void {
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
