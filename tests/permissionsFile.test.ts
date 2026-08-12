import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pickPermissionsFile,
  resolveUserScope,
  resolveWorkspaceScope,
  userScopeDir,
  workspaceRootsDir,
} from '../src/permissionsFile';
import { workspaceRootHash } from '../src/workspaceHash';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'permissions-for-kiro-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function write(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

describe('userScopeDir / workspaceRootsDir', () => {
  it('ホーム配下の固定パスを返す', () => {
    expect(userScopeDir('/home/test')).toBe(path.join('/home/test', '.kiro', 'settings'));
    expect(workspaceRootsDir('/home/test')).toBe(
      path.join('/home/test', '.kiro', 'workspace-roots'),
    );
  });
});

describe('pickPermissionsFile', () => {
  it('permissions.yaml があればそれを選ぶ', async () => {
    await write(path.join(home, 'permissions.yaml'), 'rules: []\n');

    const result = await pickPermissionsFile(home);

    expect(result.filePath).toBe(path.join(home, 'permissions.yaml'));
    expect(result.exists).toBe(true);
    expect(result.format).toBe('yaml');
  });

  it('permissions.json のみならそれを選ぶ', async () => {
    await write(path.join(home, 'permissions.json'), '{"rules":[]}');

    const result = await pickPermissionsFile(home);

    expect(result.filePath).toBe(path.join(home, 'permissions.json'));
    expect(result.exists).toBe(true);
    expect(result.format).toBe('json');
  });

  it('両方あれば permissions.yaml を優先する', async () => {
    await write(path.join(home, 'permissions.yaml'), 'rules: []\n');
    await write(path.join(home, 'permissions.json'), '{"rules":[]}');

    const result = await pickPermissionsFile(home);

    expect(result.format).toBe('yaml');
  });

  it('空の permissions.yaml でも json より優先する（本体の「読み込み」側の挙動）', async () => {
    // 本体の「開く」側は非空を条件にするため json を選ぶが、実際に効くルールは空の yaml 側。
    await write(path.join(home, 'permissions.yaml'), '');
    await write(path.join(home, 'permissions.json'), '{"rules":[{"capability":"shell"}]}');

    const result = await pickPermissionsFile(home);

    expect(result.format).toBe('yaml');
    expect(result.exists).toBe(true);
  });

  it('どちらも無ければ permissions.yaml を作成先として返す', async () => {
    const result = await pickPermissionsFile(path.join(home, 'missing'));

    expect(result.filePath).toBe(path.join(home, 'missing', 'permissions.yaml'));
    expect(result.exists).toBe(false);
    expect(result.format).toBe('yaml');
  });
});

describe('resolveUserScope', () => {
  it('~/.kiro/settings 配下を解決する', async () => {
    await write(path.join(userScopeDir(home), 'permissions.yaml'), 'rules: []\n');

    const result = await resolveUserScope(home);

    expect(result.dir).toBe(userScopeDir(home));
    expect(result.exists).toBe(true);
  });

  it('未作成でも作成先のパスを返す', async () => {
    const result = await resolveUserScope(home);

    expect(result.filePath).toBe(path.join(userScopeDir(home), 'permissions.yaml'));
    expect(result.exists).toBe(false);
  });
});

describe('resolveWorkspaceScope', () => {
  const root = '/Users/test/project';

  it('ハッシュのディレクトリがあれば resolvedVia: hash で解決する', async () => {
    const hash = workspaceRootHash(root, 'darwin');
    await write(path.join(workspaceRootsDir(home), hash, 'permissions.yaml'), 'rules: []\n');

    const result = await resolveWorkspaceScope(root, home, 'darwin');

    expect(result.hash).toBe(hash);
    expect(result.resolvedVia).toBe('hash');
    expect(result.exists).toBe(true);
    expect(result.dir).toBe(path.join(workspaceRootsDir(home), hash));
  });

  it('ディレクトリはあるがファイルが無い場合は exists: false になる', async () => {
    const hash = workspaceRootHash(root, 'darwin');
    await fs.mkdir(path.join(workspaceRootsDir(home), hash), { recursive: true });

    const result = await resolveWorkspaceScope(root, home, 'darwin');

    expect(result.resolvedVia).toBe('hash');
    expect(result.exists).toBe(false);
    expect(result.filePath).toBe(path.join(workspaceRootsDir(home), hash, 'permissions.yaml'));
  });

  it('NFD 側のディレクトリしか無い場合は resolvedVia: hash-normalized で解決する', async () => {
    const nfcRoot = '/Users/test/プロジェクト'.normalize('NFC');
    const nfdHash = workspaceRootHash(nfcRoot.normalize('NFD'), 'darwin');
    await write(path.join(workspaceRootsDir(home), nfdHash, 'permissions.yaml'), 'rules: []\n');

    const result = await resolveWorkspaceScope(nfcRoot, home, 'darwin');

    expect(result.hash).toBe(nfdHash);
    expect(result.resolvedVia).toBe('hash-normalized');
    expect(result.exists).toBe(true);
  });

  it('ハッシュで見つからない場合は .trust-migration.json を走査する', async () => {
    const unrelatedDir = path.join(workspaceRootsDir(home), 'deadbeefdeadbeef');
    await write(
      path.join(unrelatedDir, '.trust-migration.json'),
      JSON.stringify({ root, migratedAt: '2026-01-01T00:00:00Z' }),
    );
    await write(path.join(unrelatedDir, 'permissions.yaml'), 'rules: []\n');

    const result = await resolveWorkspaceScope(root, home, 'darwin');

    expect(result.resolvedVia).toBe('reverse-scan');
    expect(result.hash).toBe('deadbeefdeadbeef');
    expect(result.exists).toBe(true);
  });

  it('reverse-scan は Unicode 正規化の違いを無視して照合する', async () => {
    const nfcRoot = '/Users/test/プロジェクト'.normalize('NFC');
    const dir = path.join(workspaceRootsDir(home), 'aaaaaaaaaaaaaaaa');
    await write(
      path.join(dir, '.trust-migration.json'),
      JSON.stringify({ root: nfcRoot.normalize('NFD') }),
    );

    const result = await resolveWorkspaceScope(nfcRoot, home, 'darwin');

    expect(result.resolvedVia).toBe('reverse-scan');
    expect(result.hash).toBe('aaaaaaaaaaaaaaaa');
  });

  it('NFC / NFD 両方のディレクトリがある場合は入力の正規形に対応する方を採る（Q27 = A）', async () => {
    // 実機で見つかった状態の再現。同一パスに 2 つのハッシュディレクトリが併存し、
    // NFC 側にだけ permissions.yaml がある。
    const nfc = '/Users/test/ライブラリ'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    const nfcHash = workspaceRootHash(nfc, 'darwin');
    const nfdHash = workspaceRootHash(nfd, 'darwin');

    expect(nfcHash).not.toBe(nfdHash);
    await write(path.join(workspaceRootsDir(home), nfcHash, 'permissions.yaml'), 'rules: []\n');
    await fs.mkdir(path.join(workspaceRootsDir(home), nfdHash), { recursive: true });

    // NFC で渡されれば設定が見つかる。
    const fromNfc = await resolveWorkspaceScope(nfc, home, 'darwin');
    expect(fromNfc.hash).toBe(nfcHash);
    expect(fromNfc.resolvedVia).toBe('hash');
    expect(fromNfc.exists).toBe(true);

    // NFD で渡された場合は NFD 側のディレクトリで打ち切り、`exists: false` になる。
    // ファイルが実在する NFC 側へはフォールバックしない（Kiro 本体の挙動に合わせる）。
    const fromNfd = await resolveWorkspaceScope(nfd, home, 'darwin');
    expect(fromNfd.hash).toBe(nfdHash);
    expect(fromNfd.resolvedVia).toBe('hash');
    expect(fromNfd.exists).toBe(false);
  });

  it('壊れた .trust-migration.json は無視する', async () => {
    const dir = path.join(workspaceRootsDir(home), 'bbbbbbbbbbbbbbbb');
    await write(path.join(dir, '.trust-migration.json'), 'not json at all');

    const result = await resolveWorkspaceScope(root, home, 'darwin');

    expect(result.resolvedVia).toBe('hash');
    expect(result.exists).toBe(false);
  });

  it('どこにも無い場合は既定のハッシュパスを exists: false で返す', async () => {
    const result = await resolveWorkspaceScope(root, home, 'darwin');

    expect(result.hash).toBe(workspaceRootHash(root, 'darwin'));
    expect(result.resolvedVia).toBe('hash');
    expect(result.exists).toBe(false);
  });

  it('Windows のパスでも解決できる', async () => {
    const winRoot = 'C:\\Users\\Test\\Project';
    const hash = workspaceRootHash(winRoot, 'win32');
    await write(path.join(workspaceRootsDir(home), hash, 'permissions.json'), '{"rules":[]}');

    const result = await resolveWorkspaceScope(winRoot, home, 'win32');

    expect(result.resolvedVia).toBe('hash');
    expect(result.format).toBe('json');
    expect(result.exists).toBe(true);
  });
});
