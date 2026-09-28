import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { PermissionsTreeDataProvider, RevealTarget, TreeNode } from './tree';
import { REVEAL_LOCATION_COMMAND } from './tree';

export const REFRESH_COMMAND = 'permissionsForKiro.refresh';
export const OPEN_SCOPE_FILE_COMMAND = 'permissionsForKiro.openScopeFile';

/**
 * ファイルが無い場合に書き込む内容。
 *
 * Kiro 本体の `openPermissions*` コマンドと同じテンプレートにしている。
 */
const EMPTY_PERMISSIONS = 'rules: []\n';

/** 指定行にカーソルを置いてファイルを開く。 */
export async function revealLocation(target: RevealTarget): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.filePath));
    const editor = await vscode.window.showTextDocument(document, { preview: true });

    // ファイルが外部で編集されて短くなっている場合に備えて範囲を丸める。
    const line = Math.max(0, Math.min(target.line, document.lineCount - 1));
    const position = new vscode.Position(line, 0);

    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not open ${target.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * スコープ行のペンシルから呼ばれる。該当ファイルを開き、無ければ作成してから開く。
 *
 * ルールの追加・削除・変更はしない（ファイルを編集するのは利用者）。作成だけが唯一の書き込み操作。
 */
export async function openScopeFile(node: TreeNode | undefined): Promise<void> {
  if (node?.kind !== 'scope') {
    // ペンシルは `view/item/context` からのみ呼ばれ、コマンドパレットでは隠している。
    return;
  }

  const { filePath, exists } = node.scope.file;

  try {
    if (!exists) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, EMPTY_PERMISSIONS, 'utf8');
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not open ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function registerCommands(provider: PermissionsTreeDataProvider): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      provider.refresh();
    }),
    vscode.commands.registerCommand(OPEN_SCOPE_FILE_COMMAND, async (node?: TreeNode) => {
      await openScopeFile(node);
      // 作成した場合はツリーの状態が変わるため読み直す。
      provider.refresh();
    }),
    vscode.commands.registerCommand(REVEAL_LOCATION_COMMAND, async (target: RevealTarget) => {
      await revealLocation(target);
    }),
  ];
}
