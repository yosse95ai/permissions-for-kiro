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

    expect(createdWatchers).toHaveLength(2);
    expect(createdWatchers[0]!.watched.baseUri.fsPath).toBe('/home/test/.kiro/settings');
    expect(createdWatchers[0]!.watched.pattern).toBe('{permissions.yaml,permissions.json}');
    expect(createdWatchers[1]!.watched.baseUri.fsPath).toBe('/home/test/.kiro/workspace-roots');
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

describe('isPermissionsFile', () => {
  const home = '/home/test';

  it('User スコープのファイルを認識する', () => {
    expect(isPermissionsFile('/home/test/.kiro/settings/permissions.yaml', home)).toBe(true);
    expect(isPermissionsFile('/home/test/.kiro/settings/permissions.json', home)).toBe(true);
  });

  it('ワークスペースルートのファイルを認識する', () => {
    expect(
      isPermissionsFile('/home/test/.kiro/workspace-roots/a22ec86d9a804c48/permissions.yaml', home),
    ).toBe(true);
  });

  it('ファイル名が違うものは対象外', () => {
    expect(isPermissionsFile('/home/test/.kiro/settings/mcp.json', home)).toBe(false);
    expect(isPermissionsFile('/home/test/.kiro/settings/permissions.yml', home)).toBe(false);
    expect(isPermissionsFile('/home/test/.kiro/settings/permissions.md', home)).toBe(false);
  });

  it('置き場所が違うものは対象外', () => {
    expect(isPermissionsFile('/home/test/.kiro/permissions.yaml', home)).toBe(false);
    expect(isPermissionsFile('/Users/test/project/permissions.yaml', home)).toBe(false);
    // ワークスペース内の .kiro は Kiro に読まれないため対象外（memory.md 4.1）。
    expect(isPermissionsFile('/Users/test/project/.kiro/settings/permissions.yaml', home)).toBe(
      false,
    );
  });

  it('ハッシュディレクトリより深い階層は対象外', () => {
    expect(
      isPermissionsFile(
        '/home/test/.kiro/workspace-roots/a22ec86d9a804c48/nested/permissions.yaml',
        home,
      ),
    ).toBe(false);
  });
});
