import { describe, expect, it } from 'vitest';

import { normalizeRoot, rootCandidates, workspaceRootHash } from '../src/workspaceHash';

describe('normalizeRoot', () => {
  describe('posix', () => {
    it('絶対パスをそのまま返す', () => {
      expect(normalizeRoot('/Users/test/project', 'darwin')).toBe('/Users/test/project');
    });

    it('末尾のスラッシュを除去する', () => {
      expect(normalizeRoot('/Users/test/project/', 'darwin')).toBe('/Users/test/project');
      expect(normalizeRoot('/Users/test/project///', 'darwin')).toBe('/Users/test/project');
    });

    it('ルート `/` は 1 文字なので除去しない', () => {
      expect(normalizeRoot('/', 'darwin')).toBe('/');
    });

    it('`.` と `..` を解決する', () => {
      expect(normalizeRoot('/Users/test/./project', 'darwin')).toBe('/Users/test/project');
      expect(normalizeRoot('/Users/test/tmp/../project', 'darwin')).toBe('/Users/test/project');
    });

    it('重複したスラッシュを畳む', () => {
      expect(normalizeRoot('/Users//test///project', 'darwin')).toBe('/Users/test/project');
    });

    it('大文字小文字を保つ', () => {
      expect(normalizeRoot('/Users/Test/Project', 'darwin')).toBe('/Users/Test/Project');
    });
  });

  describe('win32', () => {
    it('バックスラッシュをスラッシュに変換する', () => {
      expect(normalizeRoot('C:\\Users\\test\\project', 'win32')).toBe('c:/users/test/project');
    });

    it('小文字化する', () => {
      expect(normalizeRoot('C:/Users/Test/Project', 'win32')).toBe('c:/users/test/project');
    });

    it('末尾のスラッシュを除去する', () => {
      expect(normalizeRoot('C:\\Users\\test\\project\\', 'win32')).toBe('c:/users/test/project');
    });

    it('ドライブレターのみの場合は末尾スラッシュを残す', () => {
      // 除去すると `C:` になってしまうため、本体は `/^[A-Za-z]:$/` を除外している。
      expect(normalizeRoot('C:\\', 'win32')).toBe('c:/');
      expect(normalizeRoot('C:/', 'win32')).toBe('c:/');
    });

    it('UNC パスの先頭 `//` を保つ', () => {
      // path.posix.normalize は先頭の `//` を `/` に縮めるため、本体は `/` を補って復元する。
      expect(normalizeRoot('\\\\server\\share', 'win32')).toBe('//server/share');
      expect(normalizeRoot('\\\\server\\share\\project', 'win32')).toBe('//server/share/project');
    });

    it('posix では先頭 `//` を復元しない', () => {
      expect(normalizeRoot('//server/share', 'darwin')).toBe('/server/share');
    });
  });
});

describe('workspaceRootHash', () => {
  // 期待値は実装とは独立に算出したもの（`printf '%s' <path> | shasum -a 256 | cut -c1-16`）。
  it.each<[string, NodeJS.Platform, string]>([
    ['/Users/test/project', 'darwin', '0654434d556baf69'],
    ['/', 'darwin', '8a5edab282632443'],
    ['C:\\Users\\test\\project', 'win32', '832482bca13fe1ad'],
    ['//server/share', 'win32', '72babc19d3a8ca32'],
  ])('%s (%s) のハッシュは %s', (root, platform, expected) => {
    expect(workspaceRootHash(root, platform)).toBe(expected);
  });

  it('16 桁の小文字 hex を返す', () => {
    expect(workspaceRootHash('/Users/test/project', 'darwin')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('末尾スラッシュの有無で同じハッシュになる', () => {
    expect(workspaceRootHash('/Users/test/project/', 'darwin')).toBe(
      workspaceRootHash('/Users/test/project', 'darwin'),
    );
  });

  it('Windows では大文字小文字の違いを無視する', () => {
    expect(workspaceRootHash('C:\\Users\\Test\\Project', 'win32')).toBe(
      workspaceRootHash('c:/users/test/project', 'win32'),
    );
  });

  it('posix では大文字小文字を区別する', () => {
    expect(workspaceRootHash('/Users/Test/project', 'darwin')).not.toBe(
      workspaceRootHash('/users/test/project', 'darwin'),
    );
  });

  it('NFC と NFD でハッシュが変わる', () => {
    const nfc = '/Users/test/プロジェクト'.normalize('NFC');
    const nfd = '/Users/test/プロジェクト'.normalize('NFD');

    expect(nfc).not.toBe(nfd);
    expect(workspaceRootHash(nfc, 'darwin')).toBe('77150c0c25e62177');
    expect(workspaceRootHash(nfd, 'darwin')).toBe('6e14a88cddee3e29');
  });
});

describe('rootCandidates', () => {
  it('ASCII のみのパスでは候補が 1 つになる', () => {
    expect(rootCandidates('/Users/test/project')).toEqual(['/Users/test/project']);
  });

  it('日本語を含むパスでは NFC と NFD の 2 候補を返す', () => {
    const candidates = rootCandidates('/Users/test/プロジェクト'.normalize('NFC'));

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe('/Users/test/プロジェクト'.normalize('NFC'));
    expect(candidates).toContain('/Users/test/プロジェクト'.normalize('NFD'));
  });

  it('先頭は常に入力そのもの', () => {
    const nfd = '/Users/test/プロジェクト'.normalize('NFD');

    expect(rootCandidates(nfd)[0]).toBe(nfd);
  });
});
