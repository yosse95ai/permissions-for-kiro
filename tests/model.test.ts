import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadScopes, rulesOf } from '../src/model';
import { workspaceRootsDir } from '../src/permissionsFile';
import { workspaceRootHash } from '../src/workspaceHash';
import { resetMocks, Uri, workspace } from './mocks/vscode';

/**
 * `loadScopes()` のテスト。
 *
 * **一時ディレクトリを HOME に見立てて実ファイルを読む。** `loadScopes(home)` が引数で
 * ホームを受け取る設計なので、`os.homedir()` を差し替えずに済む。
 */

let home: string;

beforeEach(async () => {
  resetMocks();
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'permissions-for-kiro-home-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function writeUserPermissions(text: string): Promise<void> {
  const dir = path.join(home, '.kiro', 'settings');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'permissions.yaml'), text, 'utf8');
}

/** ワークスペースルートのハッシュディレクトリに書き込む。 */
async function writeWorkspacePermissions(root: string, text: string): Promise<void> {
  const dir = path.join(workspaceRootsDir(home), workspaceRootHash(root));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'permissions.yaml'), text, 'utf8');
}

function openFolders(...roots: string[]): void {
  workspace.workspaceFolders = roots.map((root, index) => ({
    uri: Uri.file(root),
    name: path.basename(root),
    index,
  }));
}

const VALID = 'rules:\n  - capability: shell\n    effect: allow\n';

describe('スコープの並び', () => {
  it('フォルダ未オープンなら User だけを返す', async () => {
    const scopes = await loadScopes(home);

    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.kind).toBe('user');
  });

  it('User は常に最後に来る', async () => {
    openFolders('/tmp/project-a');

    const scopes = await loadScopes(home);

    expect(scopes.map((scope) => scope.kind)).toEqual(['workspace', 'user']);
  });

  it('マルチルートは workspaceFolders の順に並べる（ソートしない）', async () => {
    openFolders('/tmp/zzz', '/tmp/aaa');

    const scopes = await loadScopes(home);

    expect(scopes.map((scope) => scope.label)).toEqual(['zzz', 'aaa', 'User']);
  });

  it('id の元になる key はワークスペースのパス由来（ハッシュを使わない）', async () => {
    openFolders('/tmp/project-a');

    const scopes = await loadScopes(home);

    expect(scopes[0]!.key).toBe('workspace:/tmp/project-a');
    expect(scopes[1]!.key).toBe('user');
  });
});

describe('ファイルの読み込み', () => {
  it('ファイルが無ければ missing になる', async () => {
    const scopes = await loadScopes(home);

    expect(scopes[0]!.content.state).toBe('missing');
    expect(scopes[0]!.file.exists).toBe(false);
  });

  it('User スコープを読んでルールを返す', async () => {
    await writeUserPermissions(VALID);

    const scopes = await loadScopes(home);

    expect(scopes[0]!.content.state).toBe('parsed');
    expect(rulesOf(scopes[0]!).map((rule) => rule.capability)).toEqual(['shell']);
  });

  it('ワークスペースはルートごとのハッシュディレクトリから読む', async () => {
    const root = '/tmp/project-a';
    openFolders(root);
    await writeWorkspacePermissions(root, 'rules:\n  - capability: fs_read\n    effect: allow\n');

    const scopes = await loadScopes(home);

    expect(rulesOf(scopes[0]!).map((rule) => rule.capability)).toEqual(['fs_read']);
    // User 側は未設定のまま。スコープごとに独立して読む。
    expect(scopes[1]!.content.state).toBe('missing');
  });

  it('マルチルートではルートごとに別のファイルを読む', async () => {
    openFolders('/tmp/project-a', '/tmp/project-b');
    await writeWorkspacePermissions(
      '/tmp/project-a',
      'rules:\n  - capability: fs_read\n    effect: allow\n',
    );
    await writeWorkspacePermissions(
      '/tmp/project-b',
      'rules:\n  - capability: web_fetch\n    effect: allow\n',
    );

    const scopes = await loadScopes(home);

    expect(rulesOf(scopes[0]!).map((rule) => rule.capability)).toEqual(['fs_read']);
    expect(rulesOf(scopes[1]!).map((rule) => rule.capability)).toEqual(['web_fetch']);
  });

  it('読めなかったスコープは rulesOf が空配列を返す', async () => {
    const scopes = await loadScopes(home);

    expect(rulesOf(scopes[0]!)).toEqual([]);
  });
});

describe('検証結果の付与', () => {
  it('正しいファイルでは問題なしになる', async () => {
    await writeUserPermissions(VALID);

    const scopes = await loadScopes(home);

    expect(scopes[0]!.validation.fatal).toEqual([]);
    expect(scopes[0]!.validation.skipped.size).toBe(0);
  });

  it('未知の capability は skip として記録される', async () => {
    await writeUserPermissions('rules:\n  - capability: dev\n    effect: deny\n');

    const scopes = await loadScopes(home);

    expect(scopes[0]!.validation.fatal).toEqual([]);
    expect(scopes[0]!.validation.skipped.size).toBe(1);
  });

  it('fatal な内容は fatal として記録される', async () => {
    await writeUserPermissions('something: else\n');

    const scopes = await loadScopes(home);

    expect(scopes[0]!.validation.fatal).toHaveLength(1);
  });

  it('ファイルが無いスコープの検証結果は空（fatal 扱いにしない）', async () => {
    // 未設定はエラーではない。Kiro もファイルが無ければ単に無視する。
    const scopes = await loadScopes(home);

    expect(scopes[0]!.content.state).toBe('missing');
    expect(scopes[0]!.validation.fatal).toEqual([]);
  });

  it('スコープごとに独立した検証結果を持つ（Map を共有しない）', async () => {
    openFolders('/tmp/project-a');
    await writeWorkspacePermissions('/tmp/project-a', 'rules:\n  - capability: dev\n');
    await writeUserPermissions(VALID);

    const scopes = await loadScopes(home);

    expect(scopes[0]!.validation.skipped.size).toBe(1);
    expect(scopes[1]!.validation.skipped.size).toBe(0);
  });
});

describe('permissions.json', () => {
  it('yaml が無ければ json を読む', async () => {
    const dir = path.join(home, '.kiro', 'settings');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'permissions.json'),
      JSON.stringify({ rules: [{ capability: 'mcp', effect: 'allow' }] }),
      'utf8',
    );

    const scopes = await loadScopes(home);

    expect(scopes[0]!.file.format).toBe('json');
    expect(rulesOf(scopes[0]!).map((rule) => rule.capability)).toEqual(['mcp']);
  });

  it('yaml と json が両方あれば yaml を読む（本体の読み込み順に合わせる）', async () => {
    const dir = path.join(home, '.kiro', 'settings');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'permissions.yaml'), VALID, 'utf8');
    await fs.writeFile(
      path.join(dir, 'permissions.json'),
      JSON.stringify({ rules: [{ capability: 'mcp', effect: 'allow' }] }),
      'utf8',
    );

    const scopes = await loadScopes(home);

    expect(scopes[0]!.file.format).toBe('yaml');
    expect(rulesOf(scopes[0]!).map((rule) => rule.capability)).toEqual(['shell']);
  });
});
