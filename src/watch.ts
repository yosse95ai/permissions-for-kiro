import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { PERMISSIONS_FILES, userScopeDir, workspaceRootsDir } from './permissionsFile';
import { normalizeRoot } from './workspaceHash';

/** ファイル保存時は create / change / delete が短時間に連続するため、まとめて 1 回にする。 */
const DEBOUNCE_MS = 300;

/** `{permissions.yaml,permissions.json}` */
const PERMISSIONS_GLOB = `{${PERMISSIONS_FILES.join(',')}}`;

export interface Debouncer {
  trigger(): void;
  /** 保留中の呼び出しを取り消す。取り消した後も `trigger()` は使える。 */
  cancel(): void;
  dispose(): void;
}

/**
 * 連続した呼び出しを最後の 1 回にまとめる。
 *
 * `dispose()` で保留中のタイマーを取り消す。拡張が無効化された後にコールバックが
 * 走らないようにするために必要。
 */
export function createDebouncer(callback: () => void, delayMs: number = DEBOUNCE_MS): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    trigger(): void {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        callback();
      }, delayMs);
    },
    cancel,
    dispose: cancel,
  };
}

/**
 * 保存されたファイルが監視対象の permissions ファイルかを判定する。
 *
 * - `~/.kiro/settings/permissions.{yaml,json}`
 * - `~/.kiro/workspace-roots/<hash>/permissions.{yaml,json}`
 *
 * **パスの比較は `normalizeRoot()` を通す**。`filePath` には
 * `document.uri.fsPath` が渡るが、Windows ではドライブレターが小文字に落ちる一方
 * `os.homedir()` は大文字を返すため、素の文字列比較は必ず外れる。
 *
 * @param platform 判定に使うプラットフォーム。テストで Windows の挙動を検証するために差し替える
 */
export function isPermissionsFile(
  filePath: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // 区切り文字の解釈も `platform` に合わせる（`normalizeRoot()` と同じ設計）。
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  const name = pathApi.basename(filePath);
  if (!PERMISSIONS_FILES.some((candidate) => candidate === name)) {
    return false;
  }

  const dir = pathApi.dirname(filePath);
  if (normalizeRoot(dir, platform) === normalizeRoot(userScopeDir(home, platform), platform)) {
    return true;
  }

  // ハッシュディレクトリの直下のみを対象にする（それより深い階層は無関係）。
  return (
    normalizeRoot(pathApi.dirname(dir), platform) ===
    normalizeRoot(workspaceRootsDir(home, platform), platform)
  );
}

/**
 * permissions ファイルとワークスペースフォルダの変更を監視する。
 *
 * 監視対象はホームディレクトリ配下なので、ワークスペース相対ではなく
 * `RelativePattern` に絶対パスの `Uri` を渡す。
 *
 * - `~/.kiro/settings/permissions.{yaml,json}`
 * - `~/.kiro/workspace-roots/<hash>/permissions.{yaml,json}`（ハッシュディレクトリが
 *   後から作られる場合もあるため `**` で受ける）
 *
 * ワークスペースフォルダの増減はハッシュの対象そのものが変わるため、デバウンスせず
 * 即座に読み直す。
 */
export function watchPermissions(
  refresh: () => void,
  home: string = os.homedir(),
): vscode.Disposable[] {
  const debouncer = createDebouncer(refresh);
  const disposables: vscode.Disposable[] = [{ dispose: (): void => debouncer.dispose() }];

  const patterns = [
    new vscode.RelativePattern(vscode.Uri.file(userScopeDir(home)), PERMISSIONS_GLOB),
    new vscode.RelativePattern(vscode.Uri.file(workspaceRootsDir(home)), `**/${PERMISSIONS_GLOB}`),
  ];

  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onEvent = (): void => {
      debouncer.trigger();
    };

    disposables.push(
      watcher,
      watcher.onDidCreate(onEvent),
      watcher.onDidChange(onEvent),
      watcher.onDidDelete(onEvent),
    );
  }

  disposables.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refresh();
    }),

    // `FileSystemWatcher` はホーム配下の変更検知に実測で 2 秒近くかかる。エディタ内での
    // 保存はここで即座に拾う（外部エディタや Kiro 本体による書き込みは watcher 経由）。
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isPermissionsFile(document.uri.fsPath, home)) {
        return;
      }
      // この直後に watcher も発火するが、保留を消しておけば二重の読み込みが 1 回減る。
      debouncer.cancel();
      refresh();
    }),
  );

  return disposables;
}
