/* oxlint-disable eslint/no-await-in-loop */
// このファイルの探索はいずれも「最初に見つかったものを採用して打ち切る」逐次処理。
// Promise.all で並列化すると不要な stat / readFile が増えるため、意図的に逐次で await する。
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { normalizeRoot, rootCandidates, workspaceRootHash } from './workspaceHash';

/** Kiro が探索するファイル名。この順に探し、最初に見つかったものを読む。 */
export const PERMISSIONS_FILES = ['permissions.yaml', 'permissions.json'] as const;

export type PermissionsFormat = 'yaml' | 'json';

/** ワークスペースディレクトリの解決経路。ハッシュ規則が変わったときの診断に使う。 */
export type ResolvedVia = 'hash' | 'hash-normalized' | 'reverse-scan';

const TRUST_MIGRATION_FILE = '.trust-migration.json';

export interface ScopeFile {
  /** ファイルが置かれる（べき）ディレクトリ */
  dir: string;
  /** 読み込み対象のファイル。存在しない場合は作成すべきパス（`permissions.yaml`） */
  filePath: string;
  exists: boolean;
  format: PermissionsFormat;
}

export interface WorkspaceScopeFile extends ScopeFile {
  /** `~/.kiro/workspace-roots/<hash>` の hash 部分 */
  hash: string;
  resolvedVia: ResolvedVia;
}

function formatOf(filePath: string): PermissionsFormat {
  return filePath.endsWith('.json') ? 'json' : 'yaml';
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * ディレクトリ内から読み込むべき permissions ファイルを選ぶ。
 *
 * **Kiro 本体の「読み込み」側のロジックに合わせている。** `permissions.yaml` →
 * `permissions.json` の順に存在を確認し、最初に見つかったものを返す（中身が空かどうかは見ない）。
 * 本体の「開く」側は非空であることも条件にするため、空の yaml と内容のある json が併存する
 * ケースで挙動が分かれる。この拡張は実際に効いているルールを表示するのが目的なので
 * 「読み込み」側に揃える。
 *
 * どちらも存在しない場合は `permissions.yaml` のパスを `exists: false` で返す（作成先になる）。
 */
export async function pickPermissionsFile(dir: string): Promise<ScopeFile> {
  for (const name of PERMISSIONS_FILES) {
    const filePath = path.join(dir, name);
    if (await isFile(filePath)) {
      return { dir, filePath, exists: true, format: formatOf(filePath) };
    }
  }

  const fallback = path.join(dir, PERMISSIONS_FILES[0]);
  return { dir, filePath: fallback, exists: false, format: 'yaml' };
}

/**
 * `platform` に対応する `path` の実装を返す。
 *
 * テストで Windows / posix 両方の挙動を片方の OS から検証できるようにするために使う
 * （`workspaceHash.ts` の `normalizeRoot` と同じ設計）。
 */
function pathFor(platform: NodeJS.Platform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** `~/.kiro/settings` */
export function userScopeDir(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(home, '.kiro', 'settings');
}

/** `~/.kiro/workspace-roots` */
export function workspaceRootsDir(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(home, '.kiro', 'workspace-roots');
}

/** User スコープのファイルを解決する。 */
export async function resolveUserScope(home: string = os.homedir()): Promise<ScopeFile> {
  return pickPermissionsFile(userScopeDir(home));
}

/**
 * `.trust-migration.json` を全走査して、記録されている `root` がワークスペースパスと
 * （Kiro と同じパス正規化と Unicode 正規化の違いを無視して）一致するディレクトリを探す。
 *
 * ハッシュ規則やパス正規化が想定と変わった場合の最後の砦。通常はハッシュで解決できるため
 * 実行されない。
 *
 * **比較は `normalizeRoot()` を通す**。Windows ではドライブレターの大文字小文字と
 * 区切り文字が経路によって変わるため、素の文字列比較では外れる。
 */
async function reverseScan(
  root: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const base = workspaceRootsDir(home);

  let entries: string[];
  try {
    entries = await fs.readdir(base);
  } catch {
    return undefined;
  }

  const wanted = normalizeRoot(root, platform).normalize('NFC');
  for (const entry of entries) {
    const manifest = path.join(base, entry, TRUST_MIGRATION_FILE);
    try {
      const raw = await fs.readFile(manifest, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && 'root' in parsed) {
        const recorded: unknown = parsed.root;
        if (
          typeof recorded === 'string' &&
          normalizeRoot(recorded, platform).normalize('NFC') === wanted
        ) {
          return path.join(base, entry);
        }
      }
    } catch {
      // 読めない / JSON でない場合は次の候補へ
    }
  }

  return undefined;
}

/**
 * ワークスペースルートに対応する permissions ファイルを解決する。
 *
 * 探索順は次のとおり。
 *
 * 1. 素のパスから計算したハッシュのディレクトリ（`resolvedVia: 'hash'`）
 * 2. NFC / NFD に正規化したパスから計算したハッシュのディレクトリ（`'hash-normalized'`）
 * 3. `.trust-migration.json` の全走査（`'reverse-scan'`）
 *
 * どれも見つからない場合は、素のパスから計算した既定の場所を `exists: false` で返す。
 */
export async function resolveWorkspaceScope(
  root: string,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<WorkspaceScopeFile> {
  const base = workspaceRootsDir(home);
  const candidates = rootCandidates(root);

  for (const [index, candidate] of candidates.entries()) {
    const hash = workspaceRootHash(candidate, platform);
    const dir = path.join(base, hash);
    if (await isDirectory(dir)) {
      const file = await pickPermissionsFile(dir);
      return { ...file, hash, resolvedVia: index === 0 ? 'hash' : 'hash-normalized' };
    }
  }

  const scanned = await reverseScan(root, home, platform);
  if (scanned !== undefined) {
    const file = await pickPermissionsFile(scanned);
    return { ...file, hash: path.basename(scanned), resolvedVia: 'reverse-scan' };
  }

  const hash = workspaceRootHash(root, platform);
  const dir = path.join(base, hash);
  const file = await pickPermissionsFile(dir);
  return { ...file, hash, resolvedVia: 'hash' };
}
