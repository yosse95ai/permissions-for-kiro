import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OPEN_SCOPE_FILE_COMMAND,
  openScopeFile,
  REFRESH_COMMAND,
  registerCommands,
  revealLocation,
} from '../src/commands';
import type { ScopeData } from '../src/model';
import { PermissionsTreeDataProvider, REVEAL_LOCATION_COMMAND, type TreeNode } from '../src/tree';
import { okValidation } from './fixtures';
import {
  documentState,
  executeCommand,
  openedEditors,
  registeredCommands,
  resetMocks,
  shownErrors,
  showTextDocumentOptions,
  TextEditorRevealType,
} from './mocks/vscode';

/**
 * コマンドのテスト。
 *
 * **ファイルの作成は一時ディレクトリで実際に行う。** `~/.kiro` には書き込めない（memory.md 4.6）し、
 * モックで置き換えると「親ディレクトリごと作る」挙動を確かめられない。
 */

let tempDir: string;

beforeEach(async () => {
  resetMocks();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'permissions-for-kiro-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function userScope(filePath: string, exists: boolean): ScopeData {
  return {
    kind: 'user',
    key: 'user',
    label: 'User',
    file: { dir: path.dirname(filePath), filePath, exists, format: 'yaml' },
    content: { state: 'missing' },
    validation: okValidation(),
  };
}

function scopeNode(filePath: string, exists: boolean): TreeNode {
  return { kind: 'scope', scope: userScope(filePath, exists) };
}

describe('revealLocation', () => {
  it('preview で開き、指定行にカーソルを置く', async () => {
    documentState.lineCount = 20;

    await revealLocation({ filePath: '/tmp/permissions.yaml', line: 7 });

    expect(openedEditors).toHaveLength(1);
    expect(showTextDocumentOptions[0]).toEqual({ preview: true });

    const editor = openedEditors[0]!;
    expect(editor.selection?.start.line).toBe(7);
    expect(editor.selection?.start.character).toBe(0);
    // 選択ではなくカーソル移動なので start と end が同じ。
    expect(editor.selection?.end.line).toBe(7);
  });

  it('画面外なら中央に寄せて表示する', async () => {
    documentState.lineCount = 20;

    await revealLocation({ filePath: '/tmp/permissions.yaml', line: 7 });

    expect(openedEditors[0]!.revealed).toHaveLength(1);
    expect(openedEditors[0]!.revealed[0]!.type).toBe(
      TextEditorRevealType.InCenterIfOutsideViewport,
    );
  });

  it('ファイルが短くなっていても末尾に丸め込む', async () => {
    // 外部で編集されて行が減った場合。範囲外の Position を渡すと実機で例外になる。
    documentState.lineCount = 3;

    await revealLocation({ filePath: '/tmp/permissions.yaml', line: 99 });

    expect(openedEditors[0]!.selection?.start.line).toBe(2);
  });

  it('行番号が負でも 0 に丸める', async () => {
    documentState.lineCount = 5;

    await revealLocation({ filePath: '/tmp/permissions.yaml', line: -3 });

    expect(openedEditors[0]!.selection?.start.line).toBe(0);
  });

  it('開けない場合はエラーを通知して例外を投げない', async () => {
    documentState.failWith = new Error('EACCES');

    await revealLocation({ filePath: '/tmp/permissions.yaml', line: 0 });

    expect(openedEditors).toHaveLength(0);
    expect(shownErrors).toHaveLength(1);
    expect(shownErrors[0]).toContain('/tmp/permissions.yaml');
    expect(shownErrors[0]).toContain('EACCES');
  });
});

describe('openScopeFile', () => {
  it('スコープ以外のノードでは何もしない', async () => {
    // ペンシルは view/item/context からのみ呼ばれるが、防御的に確認する。
    await openScopeFile(undefined);
    await openScopeFile({
      kind: 'message',
      scope: userScope(path.join(tempDir, 'permissions.yaml'), true),
      slug: 'missing',
      label: 'x',
    });

    expect(openedEditors).toHaveLength(0);
    expect(shownErrors).toHaveLength(0);
  });

  it('ファイルが無ければ親ディレクトリごと作ってから開く', async () => {
    // ハッシュディレクトリがまだ存在しないケース。
    const filePath = path.join(tempDir, 'workspace-roots', 'abc123', 'permissions.yaml');

    await openScopeFile(scopeNode(filePath, false));

    expect(await fs.readFile(filePath, 'utf8')).toBe('rules: []\n');
    expect(openedEditors).toHaveLength(1);
  });

  it('作成する内容は Kiro 本体のテンプレートと同じ（空ファイルにしない）', async () => {
    // 空ファイルは Kiro が fail closed 扱いする（memory.md 3.4）。
    const filePath = path.join(tempDir, 'permissions.yaml');

    await openScopeFile(scopeNode(filePath, false));

    expect(await fs.readFile(filePath, 'utf8')).toBe('rules: []\n');
  });

  it('既にあるファイルは上書きしない', async () => {
    const filePath = path.join(tempDir, 'permissions.yaml');
    await fs.writeFile(filePath, 'rules:\n  - capability: shell\n', 'utf8');

    await openScopeFile(scopeNode(filePath, true));

    expect(await fs.readFile(filePath, 'utf8')).toBe('rules:\n  - capability: shell\n');
    expect(openedEditors).toHaveLength(1);
  });

  it('preview では開かない（編集するために開くため）', async () => {
    const filePath = path.join(tempDir, 'permissions.yaml');
    await fs.writeFile(filePath, 'rules: []\n', 'utf8');

    await openScopeFile(scopeNode(filePath, true));

    expect(showTextDocumentOptions[0]).toBeUndefined();
  });

  it('書き込みに失敗した場合はエラーを通知して例外を投げない', async () => {
    // ファイルを親ディレクトリの位置に置いて mkdir を失敗させる。
    const blocker = path.join(tempDir, 'blocked');
    await fs.writeFile(blocker, 'not a directory', 'utf8');

    await openScopeFile(scopeNode(path.join(blocker, 'permissions.yaml'), false));

    expect(shownErrors).toHaveLength(1);
    expect(openedEditors).toHaveLength(0);
  });
});

describe('registerCommands', () => {
  it('3 つのコマンドを登録する', () => {
    const provider = new PermissionsTreeDataProvider();
    const disposables = registerCommands(provider);

    expect([...registeredCommands.keys()]).toEqual([
      REFRESH_COMMAND,
      OPEN_SCOPE_FILE_COMMAND,
      REVEAL_LOCATION_COMMAND,
    ]);
    expect(disposables).toHaveLength(3);

    provider.dispose();
  });

  it('refresh でツリーの再読み込みが通知される', async () => {
    const provider = new PermissionsTreeDataProvider();
    registerCommands(provider);

    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });

    await executeCommand(REFRESH_COMMAND);

    expect(fired).toBe(1);
    provider.dispose();
  });

  it('ファイルを作成したあとにツリーを読み直す', async () => {
    const provider = new PermissionsTreeDataProvider();
    registerCommands(provider);

    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });

    const filePath = path.join(tempDir, 'permissions.yaml');
    await executeCommand(OPEN_SCOPE_FILE_COMMAND, scopeNode(filePath, false));

    // 作成すると件数表示が変わるため、読み直しが必要。
    expect(fired).toBe(1);
    expect(await fs.readFile(filePath, 'utf8')).toBe('rules: []\n');

    provider.dispose();
  });

  it('revealLocation コマンドから該当行を開ける', async () => {
    const provider = new PermissionsTreeDataProvider();
    registerCommands(provider);
    documentState.lineCount = 30;

    await executeCommand(REVEAL_LOCATION_COMMAND, {
      filePath: path.join(tempDir, 'permissions.yaml'),
      line: 12,
    });

    expect(openedEditors).toHaveLength(1);
    expect(openedEditors[0]!.selection?.start.line).toBe(12);

    provider.dispose();
  });

  it('dispose で登録が解除される', () => {
    const provider = new PermissionsTreeDataProvider();
    const disposables = registerCommands(provider);

    for (const disposable of disposables) {
      disposable.dispose();
    }

    expect(registeredCommands.size).toBe(0);
    provider.dispose();
  });
});
