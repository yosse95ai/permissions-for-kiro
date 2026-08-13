import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDebouncer, isPermissionsFile, watchPermissions } from '../src/watch';
// `vscode` は alias でこのファイルに解決されるため、同じモジュールインスタンスを参照する。
import {
  createdWatchers,
  fireDidSaveTextDocument,
  fireWorkspaceFoldersChange,
  resetMocks,
} from './mocks/vscode';

beforeEach(() => {
  vi.useFakeTimers();
  resetMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncer', () => {
  it('連続した呼び出しを最後の 1 回にまとめる', () => {
    const callback = vi.fn<() => void>();
    const debouncer = createDebouncer(callback, 300);

    debouncer.trigger();
    debouncer.trigger();
    debouncer.trigger();
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('間隔が空いた呼び出しはそれぞれ実行される', () => {
    const callback = vi.fn<() => void>();
    const debouncer = createDebouncer(callback, 300);

    debouncer.trigger();
    vi.advanceTimersByTime(300);
    debouncer.trigger();
    vi.advanceTimersByTime(300);

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('dispose すると保留中の呼び出しが取り消される', () => {
    const callback = vi.fn<() => void>();
    const debouncer = createDebouncer(callback, 300);

    debouncer.trigger();
    debouncer.dispose();
    vi.advanceTimersByTime(1000);

    // 拡張が無効化された後にコールバックが走らないことを保証する。
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('watchPermissions', () => {
  it('User スコープと workspace-roots の 2 つを監視する', () => {
    watchPermissions(vi.fn<() => void>(), '/home/test');

    // 監視対象のパスは実行プラットフォームの区切り文字で組まれる（Windows では `\`）。
    expect(createdWatchers).toHaveLength(2);
    expect(createdWatchers[0]!.watched.baseUri.fsPath).toBe(
      path.join('/home/test', '.kiro', 'settings'),
    );
    expect(createdWatchers[0]!.watched.pattern).toBe('{permissions.yaml,permissions.json}');
    expect(createdWatchers[1]!.watched.baseUri.fsPath).toBe(
      path.join('/home/test', '.kiro', 'workspace-roots'),
    );
    // ハッシュディレクトリは後から作られることがあるため `**` で受ける。
    expect(createdWatchers[1]!.watched.pattern).toBe('**/{permissions.yaml,permissions.json}');
  });

  it('ファイルの変更で再読み込みする', () => {
    const refresh = vi.fn<() => void>();
    watchPermissions(refresh, '/home/test');

    createdWatchers[0]!.onDidChangeEmitter.fire(undefined);
    vi.advanceTimersByTime(300);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('作成と削除でも再読み込みする', () => {
    const refresh = vi.fn<() => void>();
    watchPermissions(refresh, '/home/test');

    createdWatchers[1]!.onDidCreateEmitter.fire(undefined);
    vi.advanceTimersByTime(300);
    createdWatchers[1]!.onDidDeleteEmitter.fire(undefined);
    vi.advanceTimersByTime(300);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('保存時に連続するイベントは 1 回の再読み込みにまとまる', () => {
    const refresh = vi.fn<() => void>();
    watchPermissions(refresh, '/home/test');

    // エディタでの保存は create / change が短時間に連続することがある。
    createdWatchers[0]!.onDidCreateEmitter.fire(undefined);
    createdWatchers[0]!.onDidChangeEmitter.fire(undefined);
    createdWatchers[0]!.onDidChangeEmitter.fire(undefined);
    vi.advanceTimersByTime(300);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ワークスペースフォルダの増減では即座に再読み込みする', () => {
    const refresh = vi.fn<() => void>();
    watchPermissions(refresh, '/home/test');

    fireWorkspaceFoldersChange();

    // ハッシュの対象そのものが変わるためデバウンスしない。
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('エディタ内での保存は watcher を待たず即座に反映する', () => {
    const refresh = vi.fn<() => void>();
    watchPermissions(refresh, '/home/test');

    fireDidSaveTextDocument('/home/test/.kiro/settings/permissions.yaml');

    // タイマーを進める前に呼ばれている。
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('保存で即座に反映したあと、保留中のデバウンスは取り消される', () => {
    const refresh = vi.fn<() => void>();
    watchPermissions(refresh, '/home/test');

    // 保存前に watcher が発火していた場合でも、二重の読み込みにはしない。
    createdWatchers[0]!.onDidChangeEmitter.fire(undefined);
    fireDidSaveTextDocument('/home/test/.kiro/settings/permissions.yaml');
    vi.advanceTimersByTime(1000);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('監視対象外のファイルの保存では反映しない', () => {
    const refresh = vi.fn<() => void>();
    watchPermissions(refresh, '/home/test');

    fireDidSaveTextDocument('/Users/test/project/src/index.ts');
    fireDidSaveTextDocument('/home/test/.kiro/settings/mcp.json');
    vi.advanceTimersByTime(1000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('ワークスペースルート側の permissions ファイルの保存も拾う', () => {
    const refresh = vi.fn<() => void>();
    watchPermissions(refresh, '/home/test');

    fireDidSaveTextDocument('/home/test/.kiro/workspace-roots/a22ec86d9a804c48/permissions.json');

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('dispose すると watcher が解放され、保留中の再読み込みも取り消される', () => {
    const refresh = vi.fn<() => void>();
    const disposables = watchPermissions(refresh, '/home/test');

    createdWatchers[0]!.onDidChangeEmitter.fire(undefined);
    for (const disposable of disposables) {
      disposable.dispose();
    }
    vi.advanceTimersByTime(1000);

    expect(createdWatchers.every((watcher) => watcher.disposed)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});

// `platform` を明示して呼ぶ。実行 OS に依存せず両方の挙動を検証するため（Q41 = B）。
describe('isPermissionsFile（posix）', () => {
  const home = '/home/test';
  const isTarget = (filePath: string): boolean => isPermissionsFile(filePath, home, 'linux');

  it('User スコープのファイルを認識する', () => {
    expect(isTarget('/home/test/.kiro/settings/permissions.yaml')).toBe(true);
    expect(isTarget('/home/test/.kiro/settings/permissions.json')).toBe(true);
  });

  it('ワークスペースルートのファイルを認識する', () => {
    expect(isTarget('/home/test/.kiro/workspace-roots/a22ec86d9a804c48/permissions.yaml')).toBe(
      true,
    );
  });

  it('ファイル名が違うものは対象外', () => {
    expect(isTarget('/home/test/.kiro/settings/mcp.json')).toBe(false);
    expect(isTarget('/home/test/.kiro/settings/permissions.yml')).toBe(false);
    expect(isTarget('/home/test/.kiro/settings/permissions.md')).toBe(false);
  });

  it('置き場所が違うものは対象外', () => {
    expect(isTarget('/home/test/.kiro/permissions.yaml')).toBe(false);
    expect(isTarget('/Users/test/project/permissions.yaml')).toBe(false);
    // ワークスペース内の .kiro は Kiro に読まれないため対象外（memory.md 4.1）。
    expect(isTarget('/Users/test/project/.kiro/settings/permissions.yaml')).toBe(false);
  });

  it('ハッシュディレクトリより深い階層は対象外', () => {
    expect(
      isTarget('/home/test/.kiro/workspace-roots/a22ec86d9a804c48/nested/permissions.yaml'),
    ).toBe(false);
  });

  it('大文字小文字の違いは posix では別のパスとして扱う', () => {
    // macOS のファイルシステムは大文字小文字を区別しないが、Kiro 本体の正規化は
    // win32 以外では `toLowerCase()` しない（memory.md 3.2）。本体に合わせる。
    expect(isTarget('/Home/Test/.kiro/settings/permissions.yaml')).toBe(false);
  });
});

describe('isPermissionsFile（win32）', () => {
  // `os.homedir()` はドライブレターを大文字で返す。
  const home = 'D:\\Users\\test';
  const isTarget = (filePath: string): boolean => isPermissionsFile(filePath, home, 'win32');

  it('User スコープのファイルを認識する', () => {
    expect(isTarget('D:\\Users\\test\\.kiro\\settings\\permissions.yaml')).toBe(true);
    expect(isTarget('D:\\Users\\test\\.kiro\\settings\\permissions.json')).toBe(true);
  });

  it('ドライブレターが小文字でも認識する', () => {
    // `Uri.fsPath` はドライブレターを小文字に落とす（memory.md 4.2 の `Uri.fsPath` の項）。
    // 素の文字列比較だとここが `false` になり、保存時の即時反映が効かなくなる。
    expect(isTarget('d:\\Users\\test\\.kiro\\settings\\permissions.yaml')).toBe(true);
    expect(
      isTarget('d:\\Users\\test\\.kiro\\workspace-roots\\20b1c19bb023d9a9\\permissions.yaml'),
    ).toBe(true);
  });

  it('パス全体の大文字小文字の違いを無視する', () => {
    expect(isTarget('d:\\users\\test\\.kiro\\settings\\permissions.yaml')).toBe(true);
  });

  it('区切り文字が `/` でも認識する', () => {
    expect(isTarget('d:/Users/test/.kiro/settings/permissions.yaml')).toBe(true);
  });

  it('ワークスペースルートのファイルを認識する', () => {
    expect(
      isTarget('D:\\Users\\test\\.kiro\\workspace-roots\\20b1c19bb023d9a9\\permissions.yaml'),
    ).toBe(true);
  });

  it('ファイル名が違うものは対象外', () => {
    expect(isTarget('D:\\Users\\test\\.kiro\\settings\\mcp.json')).toBe(false);
    expect(isTarget('D:\\Users\\test\\.kiro\\settings\\permissions.yml')).toBe(false);
  });

  it('置き場所が違うものは対象外', () => {
    expect(isTarget('D:\\Users\\test\\.kiro\\permissions.yaml')).toBe(false);
    expect(isTarget('D:\\Users\\other\\.kiro\\settings\\permissions.yaml')).toBe(false);
    // ドライブが違うものは別のパス。
    expect(isTarget('C:\\Users\\test\\.kiro\\settings\\permissions.yaml')).toBe(false);
  });

  it('ハッシュディレクトリより深い階層は対象外', () => {
    expect(
      isTarget(
        'D:\\Users\\test\\.kiro\\workspace-roots\\20b1c19bb023d9a9\\nested\\permissions.yaml',
      ),
    ).toBe(false);
  });
});
