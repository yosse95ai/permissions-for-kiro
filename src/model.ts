import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import * as vscode from 'vscode';

import { parsePermissions, type ParseResult } from './parse';
import {
  type ResolvedVia,
  resolveUserScope,
  resolveWorkspaceScope,
  type ScopeFile,
} from './permissionsFile';
import { type PolicyScope, type ScopeValidation, validatePermissions } from './validate';

/** スコープの中身の状態。ツリーの表示分岐はこれで決まる。 */
export type ScopeContent =
  | { state: 'missing' }
  | { state: 'parsed'; result: ParseResult }
  | { state: 'read-error'; message: string };

interface ScopeBase {
  /**
   * `TreeItem.id` の接頭辞。
   *
   * **展開状態の保持のために安定していることが必須**（memory.md 4.2 の TreeItem.id の項）。ハッシュではなく
   * ワークスペースルートのパスを使う。ハッシュは `resolvedVia` の経路によって変わりうる。
   */
  key: string;
  label: string;
  file: ScopeFile;
  content: ScopeContent;
  /**
   * Kiro の規則に照らした検証結果（Q33 = C）。
   *
   * `content` が `parsed` 以外のときは空。`fatal` が空でなければ、**このスコープのルールは
   * 1 つも効いていない。**
   */
  validation: ScopeValidation;
}

export type ScopeData =
  | (ScopeBase & { kind: 'user' })
  | (ScopeBase & {
      kind: 'workspace';
      hash: string;
      resolvedVia: ResolvedVia;
      folder: vscode.WorkspaceFolder;
    });

/**
 * 検証結果を作る。
 *
 * 毎回新しい `Map` を返す。共有すると呼び出し側の変更が他のスコープに漏れる。
 */
function validateContent(content: ScopeContent, scope: PolicyScope): ScopeValidation {
  if (content.state !== 'parsed') {
    return { fatal: [], skipped: new Map() };
  }
  return validatePermissions(content.result, scope);
}

async function readContent(file: ScopeFile): Promise<ScopeContent> {
  if (!file.exists) {
    return { state: 'missing' };
  }

  try {
    const text = await fs.readFile(file.filePath, 'utf8');
    return { state: 'parsed', result: parsePermissions(text) };
  } catch (err) {
    return { state: 'read-error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 現在効いているスコープを読み込む。
 *
 * ワークスペースルートごとに 1 スコープを `workspaceFolders` の順に並べ、User スコープを
 * 最後に置く（Q12）。フォルダ未オープンのときは User だけになる（Q18）。
 */
export async function loadScopes(home: string = os.homedir()): Promise<ScopeData[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];

  const workspaceScopes = await Promise.all(
    folders.map(async (folder): Promise<ScopeData> => {
      const file = await resolveWorkspaceScope(folder.uri.fsPath, home);
      const content = await readContent(file);
      return {
        kind: 'workspace',
        key: `workspace:${folder.uri.fsPath}`,
        label: folder.name,
        file,
        hash: file.hash,
        resolvedVia: file.resolvedVia,
        folder,
        content,
        validation: validateContent(content, 'workspace'),
      };
    }),
  );

  const userFile = await resolveUserScope(home);
  const userContent = await readContent(userFile);
  const userScope: ScopeData = {
    kind: 'user',
    key: 'user',
    label: vscode.l10n.t('User'),
    file: userFile,
    content: userContent,
    validation: validateContent(userContent, 'user'),
  };

  return [...workspaceScopes, userScope];
}

/** スコープが持つルールを返す。読めなかった場合は空配列。 */
export function rulesOf(scope: ScopeData): ParseResult['rules'] {
  return scope.content.state === 'parsed' ? scope.content.result.rules : [];
}
