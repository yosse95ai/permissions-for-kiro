import * as crypto from 'node:crypto';
import * as path from 'node:path';

/**
 * Kiro 本体の `workspace-hash` モジュールと同じパス正規化を行う。
 *
 * **ハッシュ計算だけでなく、パスの比較にもこの関数を通す**（Q40 / Q45）。Windows では
 * `Uri.fsPath` がドライブレターを小文字に落とす一方 `os.homedir()` は大文字を返すため、
 * 素の文字列比較は必ず外れる（memory.md 4.2 の `Uri.fsPath` の項）。区切り文字の差も
 * ここで吸収される。
 *
 * 本体の実装（`@kiro/agent/dist/workspace-hash-*.js`）を移植したもの。
 *
 * ```js
 * const r = (path.isAbsolute(t) ? t : path.resolve(t)).replace(/\\/g, '/');
 * const isUncOnWin = process.platform === 'win32' && r.startsWith('//');
 * let i = path.posix.normalize(r);
 * if (isUncOnWin && !i.startsWith('//')) i = '/' + i;
 * if (i.length > 1) {
 *   const n = i.replace(/\/+$/, '');
 *   if (n.length > 0 && !/^[A-Za-z]:$/.test(n)) i = n;
 * }
 * return process.platform === 'win32' ? i.toLowerCase() : i;
 * ```
 *
 * @param input ワークスペースルートのパス
 * @param platform 判定に使うプラットフォーム。テストで Windows の挙動を検証するために差し替える
 */
export function normalizeRoot(input: string, platform: NodeJS.Platform = process.platform): string {
  const isWindows = platform === 'win32';

  // 本体は実行プラットフォームの `path.isAbsolute` を使う。ここでは `platform` に合わせて
  // 実装を選ぶことで、macOS 上から Windows の挙動を検証できるようにしている。
  // 相対パスのときの `path.resolve` だけは実行環境の cwd に依存するため差し替えない
  // （`vscode.workspace.workspaceFolders` の `fsPath` は常に絶対パスなので実務では到達しない）。
  const pathApi = isWindows ? path.win32 : path.posix;
  const absolute = pathApi.isAbsolute(input) ? input : path.resolve(input);
  const slashed = absolute.replace(/\\/g, '/');

  // UNC パス（`\\server\share`）は posix.normalize が先頭の `//` を `/` に縮めてしまう。
  const isUnc = isWindows && slashed.startsWith('//');
  let normalized = path.posix.normalize(slashed);
  if (isUnc && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  // 末尾スラッシュを除去する。ただし除去結果が空、またはドライブレターのみ（`C:`）になる
  // 場合は元のまま残す。
  if (normalized.length > 1) {
    const trimmed = normalized.replace(/\/+$/, '');
    if (trimmed.length > 0 && !/^[A-Za-z]:$/.test(trimmed)) {
      normalized = trimmed;
    }
  }

  return isWindows ? normalized.toLowerCase() : normalized;
}

/**
 * ワークスペースルート 1 つに対応するハッシュを計算する。
 *
 * `~/.kiro/workspace-roots/<hash>` のディレクトリ名になる。
 *
 * 本体の `hash()` はルートの配列を受け取り、正規化 → ソート → NUL 連結してからハッシュ化するが、
 * **permissions のパス解決では常に単一要素の配列が渡される**ため、ここでは 1 ルートのみを扱う。
 * ルートが 0 個のときの `_global` にもこの経路では到達しない（フォルダ未オープン時は
 * ワークスペーススコープ自体が存在しない）。
 */
export function workspaceRootHash(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return crypto
    .createHash('sha256')
    .update(normalizeRoot(root, platform), 'utf8')
    .digest('hex')
    .substring(0, 16);
}

/**
 * ハッシュ計算に使うパスの候補を返す。
 *
 * macOS では同一に見えるパスに対して NFC 由来と NFD 由来の 2 つのディレクトリが
 * 併存しうるため、両方を候補として探索する必要がある。
 */
export function rootCandidates(root: string): string[] {
  return [...new Set([root, root.normalize('NFC'), root.normalize('NFD')])];
}
