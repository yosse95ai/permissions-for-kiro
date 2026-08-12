import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import { OPEN_SCOPE_FILE_COMMAND, REFRESH_COMMAND } from '../src/commands';
import { activate, deactivate } from '../src/extension';
import { REVEAL_LOCATION_COMMAND, VIEW_ID } from '../src/tree';
import { createdTreeViews, createdWatchers, registeredCommands, resetMocks } from './mocks/vscode';

/**
 * `activate()` の配線を確かめる。
 *
 * **狙いは「解放漏れの検出」。** `context.subscriptions` に入れ忘れたリソースは、拡張を
 * 無効化しても残り続ける。
 */

function context(): { subscriptions: vscode.Disposable[] } {
  return { subscriptions: [] };
}

beforeEach(() => {
  resetMocks();
});

describe('activate', () => {
  it('ビューを 1 つ作る', () => {
    activate(context());

    expect(createdTreeViews).toHaveLength(1);
    expect(createdTreeViews[0]!.id).toBe(VIEW_ID);
    expect(createdTreeViews[0]!.options).toMatchObject({ showCollapseAll: true });
  });

  it('3 つのコマンドを登録する', () => {
    activate(context());

    expect([...registeredCommands.keys()]).toEqual([
      REFRESH_COMMAND,
      OPEN_SCOPE_FILE_COMMAND,
      REVEAL_LOCATION_COMMAND,
    ]);
  });

  it('ファイル監視を始める', () => {
    activate(context());

    // `~/.kiro/settings` と `~/.kiro/workspace-roots` の 2 つ（memory.md 4.2 の watcher の項）。
    expect(createdWatchers).toHaveLength(2);
  });

  it('作ったリソースをすべて subscriptions に登録する', () => {
    const ctx = context();

    activate(ctx);

    // ビュー + provider + コマンド 3 件 + 監視。数そのものより「入れ忘れが無い」ことが要点。
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(6);
    for (const subscription of ctx.subscriptions) {
      expect(typeof subscription.dispose).toBe('function');
    }
  });

  it('subscriptions を dispose するとビューと監視が解放される', () => {
    const ctx = context();
    activate(ctx);

    for (const subscription of ctx.subscriptions) {
      subscription.dispose();
    }

    expect(createdTreeViews[0]!.disposed).toBe(true);
    expect(createdWatchers.every((watcher) => watcher.disposed)).toBe(true);
    expect(registeredCommands.size).toBe(0);
  });
});

describe('deactivate', () => {
  it('例外を投げない（解放は subscriptions に任せている）', () => {
    expect(() => {
      deactivate();
    }).not.toThrow();
  });
});
