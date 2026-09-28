import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import {
  completionItems,
  completionSelector,
  hoverAt,
  type IndentChange,
  type LineSource,
  permissionsFormatOf,
  registerCompletion,
  shouldOpenSuggestAfter,
  type WatchedDocument,
} from '../src/completion';
import { userScopeDir, workspaceRootsDir } from '../src/permissionsFile';
import {
  CompletionItemKind,
  executedCommands,
  fireDidChangeTextDocument,
  MarkdownString,
  registeredCompletionProviders,
  registeredHoverProviders,
  RelativePattern,
  resetMocks,
  SnippetString,
  window,
} from './mocks/vscode';

/** 実行 OS に依存しないように、一時ディレクトリの下をホームにする。 */
const home = path.join(os.tmpdir(), 'permissions-for-kiro-home');

function document(lines: readonly string[]): LineSource {
  return { lineCount: lines.length, lineAt: (line) => ({ text: lines[line]! }) };
}

/** `|` の位置をカーソルにして候補を取る。 */
function itemsAt(
  format: 'yaml' | 'json',
  lines: readonly string[],
): vscode.CompletionItem[] | undefined {
  const line = lines.findIndex((text) => text.includes('|'));
  const character = lines[line]!.indexOf('|');
  const text = lines.map((value, i) => (i === line ? value.replace('|', '') : value));
  return completionItems(format, document(text), { line, character });
}

/** 登録されたプロバイダーが、補完を返す関数を持っているか。 */
function isProvider(value: unknown): value is {
  provideCompletionItems(doc: LineSource, pos: { line: number; character: number }): unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'provideCompletionItems' in value &&
    typeof value.provideCompletionItems === 'function'
  );
}

/** 登録されたプロバイダーが、ホバーを返す関数を持っているか。 */
function isHoverProvider(value: unknown): value is {
  provideHover(doc: LineSource, pos: { line: number; character: number }): unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'provideHover' in value &&
    typeof value.provideHover === 'function'
  );
}

function labels(items: readonly vscode.CompletionItem[] | undefined): unknown[] {
  return (items ?? []).map((item) => item.label);
}

/** テストで登録したもの。変更イベントのリスナーがテストをまたいで残らないように、毎回解放する。 */
const registrations: vscode.Disposable[] = [];

function register(): vscode.Disposable[] {
  const disposables = registerCompletion(home);
  registrations.push(...disposables);
  return disposables;
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  for (const disposable of registrations.splice(0)) {
    disposable.dispose();
  }
});

describe('completionSelector', () => {
  it('User スコープとハッシュディレクトリの直下の、同じ形式のファイルだけに一致させる', () => {
    const selector = completionSelector('yaml', home);
    expect(selector).toHaveLength(2);

    const [user, workspace] = selector;
    expect(user!.pattern).toBeInstanceOf(RelativePattern);
    expect(user).toMatchObject({
      scheme: 'file',
      language: 'yaml',
      pattern: { baseUri: { fsPath: userScopeDir(home) }, pattern: 'permissions.yaml' },
    });
    expect(workspace).toMatchObject({
      scheme: 'file',
      language: 'yaml',
      pattern: { baseUri: { fsPath: workspaceRootsDir(home) }, pattern: '*/permissions.yaml' },
    });
  });

  it('JSON は permissions.json だけに一致させる', () => {
    const selector = completionSelector('json', home);
    expect(selector.map((filter) => filter.language)).toEqual(['json', 'json']);
    expect(selector[0]!.pattern).toMatchObject({ pattern: 'permissions.json' });
    expect(selector[1]!.pattern).toMatchObject({ pattern: '*/permissions.json' });
  });
});

describe('registerCompletion', () => {
  it('YAML と JSON の 2 つを、それぞれのトリガー文字で登録する', () => {
    register();
    expect(registeredCompletionProviders.map((provider) => provider.triggerCharacters)).toEqual([
      [' '],
      ['"'],
    ]);
    expect(registeredCompletionProviders.map((provider) => provider.selector)).toEqual([
      completionSelector('yaml', home),
      completionSelector('json', home),
    ]);
  });

  it('dispose すると登録が解放される', () => {
    const disposables = register();
    for (const disposable of disposables) {
      disposable.dispose();
    }
    expect(registeredCompletionProviders).toHaveLength(0);
  });

  it('登録したプロバイダーは、形式に合った候補を返す', () => {
    register();
    const provider = registeredCompletionProviders[0]!.provider;
    if (!isProvider(provider)) {
      throw new Error('provideCompletionItems is missing');
    }
    const items = provider.provideCompletionItems(document(['r']), { line: 0, character: 1 });
    expect(items).toMatchObject([{ label: 'rules' }]);
  });
});

describe('completionItems', () => {
  it('キーの候補は Property で、置換範囲と並び順を付ける', () => {
    const items = itemsAt('yaml', ['rules:', '  - c|']);
    expect(labels(items)).toEqual(['capability', 'effect', 'match', 'exclude']);
    const [capability] = items!;
    expect(capability!.kind).toBe(CompletionItemKind.Property);
    expect(capability!.range).toMatchObject({
      start: { line: 1, character: 4 },
      end: { line: 1, character: 5 },
    });
    expect(capability!.sortText).toBe('00');
    expect(capability!.insertText).toBe('capability: ');
  });

  it('capability / effect のキーには、続けて値の候補を開くコマンドを付ける', () => {
    const items = itemsAt('yaml', ['rules:', '  - |']);
    const commands = Object.fromEntries(
      (items ?? []).map((item) => [item.label, item.command?.command]),
    );
    expect(commands).toEqual({
      capability: 'editor.action.triggerSuggest',
      effect: 'editor.action.triggerSuggest',
      match: undefined,
      exclude: undefined,
    });
  });

  it('説明文は MarkdownString にし、説明文のない候補には付けない', () => {
    const items = itemsAt('yaml', ['rules:', '  - capability: |']);
    const all = items!.find((item) => item.label === 'all');
    expect(all!.kind).toBe(CompletionItemKind.EnumMember);
    expect(all!.detail).toBe('meta capability');
    expect(all!.documentation).toBeInstanceOf(MarkdownString);
    expect(all!.documentation).toMatchObject({
      value: 'Every capability except `sandbox_network`.',
    });

    const context = items!.find((item) => item.label === 'context');
    expect(context!.detail).toBeUndefined();
    expect(context!.documentation).toBeUndefined();
  });

  it('JSON のキーはスニペットとして入れる', () => {
    const items = itemsAt('json', ['{"rules": [{"|"}]}']);
    const capability = items!.find((item) => item.label === 'capability');
    expect(capability!.insertText).toBeInstanceOf(SnippetString);
    expect(capability!.insertText).toMatchObject({ value: '"capability": "$1"' });
  });

  it('パターンのひな型は Snippet の種類で、スニペットとして入れる', () => {
    const items = itemsAt('yaml', ['rules:', '  - capability: shell', '    match:', '      - |']);
    expect(labels(items)).toEqual(['git *', 'npm test']);
    expect(items![0]!.kind).toBe(CompletionItemKind.Snippet);
    expect(items![0]!.insertText).toMatchObject({ value: '"${1:git} *"' });
  });

  it('範囲が引用符で始まるときは、絞り込みの文字列にも引用符を付ける', () => {
    const json = itemsAt('json', ['{"rules": [{"capability": "s|"}]}']);
    const shell = json!.find((item) => item.label === 'shell');
    expect(shell!.filterText).toBe('"shell');
    expect(shell!.insertText).toBe('"shell"');

    const yaml = itemsAt('yaml', ['rules:', "  - capability: 's|"]);
    expect(yaml!.find((item) => item.label === 'shell')!.filterText).toBe("'shell");
  });

  it('引用符で始まらないときは filterText を付けない（ラベルで絞る）', () => {
    const items = itemsAt('yaml', ['rules:', '  - capability: s|']);
    expect(items!.every((item) => item.filterText === undefined)).toBe(true);
  });

  it('文脈がわからない位置では undefined を返す', () => {
    expect(itemsAt('yaml', ['# c|'])).toBeUndefined();
  });

  it('文脈はわかっても出す候補がなければ undefined を返す', () => {
    expect(
      itemsAt('yaml', ['rules:', '  - capability: web_search', '    match:', '      - |']),
    ).toBeUndefined();
    expect(itemsAt('yaml', ['rules:', 'r|'])).toBeUndefined();
  });
});

/** 試験用のハッシュディレクトリの下の permissions ファイル。 */
function watched(
  lines: readonly string[],
  format: 'yaml' | 'json' = 'yaml',
  filePath: string = path.join(
    workspaceRootsDir(home),
    '0000000000000000',
    `permissions.${format}`,
  ),
  languageId: string = format,
): WatchedDocument {
  return {
    ...document(lines),
    languageId,
    uri: { scheme: 'file', fsPath: filePath },
  };
}

/** `lines` は挿入後の内容。`start` に `text` が挿入されたことにする。 */
function change(
  doc: WatchedDocument,
  start: { line: number; character: number },
  text: string,
  reason?: number,
): IndentChange {
  return { document: doc, reason, contentChanges: [{ range: { start }, text }] };
}

describe('permissionsFormatOf', () => {
  it('User スコープとハッシュディレクトリの直下の、言語と名前が合うファイルだけ', () => {
    expect(permissionsFormatOf(watched([]), home)).toBe('yaml');
    expect(permissionsFormatOf(watched([], 'json'), home)).toBe('json');
    expect(
      permissionsFormatOf(
        watched([], 'yaml', path.join(userScopeDir(home), 'permissions.yaml')),
        home,
      ),
    ).toBe('yaml');
  });

  it('対象外のファイルでは undefined', () => {
    const deeper = path.join(
      workspaceRootsDir(home),
      '0000000000000000',
      'sub',
      'permissions.yaml',
    );
    expect(permissionsFormatOf(watched([], 'yaml', deeper), home)).toBeUndefined();
    expect(
      permissionsFormatOf(watched([], 'yaml', path.join(home, 'project', 'x.yaml')), home),
    ).toBeUndefined();
    // 言語と拡張子が食い違う（`files.associations` など）
    const yamlPath = path.join(userScopeDir(home), 'permissions.yaml');
    expect(permissionsFormatOf(watched([], 'json', yamlPath), home)).toBeUndefined();
    expect(permissionsFormatOf(watched([], 'yaml', yamlPath, 'plaintext'), home)).toBeUndefined();
    expect(
      permissionsFormatOf({ ...watched([]), uri: { scheme: 'untitled', fsPath: yamlPath } }, home),
    ).toBeUndefined();
  });
});

describe('shouldOpenSuggestAfter', () => {
  const afterTab = ['rules:', '  - capability: all', '    '];

  it('Tab でキーの列まで字下げしたら開く', () => {
    expect(
      shouldOpenSuggestAfter(change(watched(afterTab), { line: 2, character: 2 }, '  '), home),
    ).toBe(true);
  });

  it('Enter でキーの列に来たら開く', () => {
    expect(
      shouldOpenSuggestAfter(change(watched(afterTab), { line: 1, character: 19 }, '\n    '), home),
    ).toBe(true);
  });

  it('Enter でルールの列に来たときは、出す候補がないので開かない', () => {
    const lines = ['rules:', '  - capability: all', '  '];
    expect(
      shouldOpenSuggestAfter(change(watched(lines), { line: 1, character: 19 }, '\n  '), home),
    ).toBe(false);
  });

  it('JSON でも、Enter のあとにキーを書く位置なら開く', () => {
    const lines = ['{"rules": [{', '  '];
    expect(
      shouldOpenSuggestAfter(
        change(watched(lines, 'json'), { line: 0, character: 12 }, '\n  '),
        home,
      ),
    ).toBe(true);
  });

  it('値のない match: のすぐ下では、キーの列に来ても開かない（`- ` を書くところ）', () => {
    const lines = ['rules:', '  - capability: shell', '    match:', '    '];
    expect(
      shouldOpenSuggestAfter(change(watched(lines), { line: 2, character: 10 }, '\n    '), home),
    ).toBe(false);
    // 手動で開いた場合は、今までどおりキーの候補が出る
    expect(labels(itemsAt('yaml', [...lines.slice(0, 3), '    |']))).toEqual(['effect', 'exclude']);
  });

  it('YAML の空白 1 文字はトリガー文字で開くので、ここでは開かない', () => {
    const lines = ['rules:', '  - '];
    expect(
      shouldOpenSuggestAfter(change(watched(lines), { line: 1, character: 3 }, ' '), home),
    ).toBe(false);
  });

  it('空白以外の挿入、元に戻す・やり直し、複数の変更、対象外のファイルでは開かない', () => {
    const doc = watched(afterTab);
    expect(shouldOpenSuggestAfter(change(doc, { line: 2, character: 2 }, 'e'), home)).toBe(false);
    expect(shouldOpenSuggestAfter(change(doc, { line: 2, character: 2 }, '  ', 1), home)).toBe(
      false,
    );
    expect(
      shouldOpenSuggestAfter(
        {
          document: doc,
          reason: undefined,
          contentChanges: [
            { range: { start: { line: 2, character: 2 } }, text: '  ' },
            { range: { start: { line: 1, character: 0 } }, text: '  ' },
          ],
        },
        home,
      ),
    ).toBe(false);
    expect(
      shouldOpenSuggestAfter({ document: doc, reason: undefined, contentChanges: [] }, home),
    ).toBe(false);
    const other = watched(afterTab, 'yaml', path.join(home, 'other.yaml'));
    expect(shouldOpenSuggestAfter(change(other, { line: 2, character: 2 }, '  '), home)).toBe(
      false,
    );
  });
});

describe('Tab と Enter のあとに候補を開く（登録したリスナー）', () => {
  const lines = ['rules:', '  - capability: all', '    '];

  it('アクティブなエディタの文書なら、候補を開くコマンドを実行する', () => {
    register();
    const doc = watched(lines);
    window.activeTextEditor = { document: doc, selections: [{}] };
    fireDidChangeTextDocument(change(doc, { line: 2, character: 2 }, '  '));
    expect(executedCommands).toEqual(['editor.action.triggerSuggest']);
  });

  it('アクティブでない文書や、複数のカーソルでは実行しない', () => {
    register();
    const doc = watched(lines);
    fireDidChangeTextDocument(change(doc, { line: 2, character: 2 }, '  '));
    window.activeTextEditor = { document: watched(lines), selections: [{}] };
    fireDidChangeTextDocument(change(doc, { line: 2, character: 2 }, '  '));
    window.activeTextEditor = { document: doc, selections: [{}, {}] };
    fireDidChangeTextDocument(change(doc, { line: 2, character: 2 }, '  '));
    window.activeTextEditor = { document: doc, selections: [{}] };
    fireDidChangeTextDocument(change(doc, { line: 2, character: 2 }, 'x'));
    expect(executedCommands).toEqual([]);
  });

  it('dispose するとリスナーも解放される', () => {
    for (const disposable of register()) {
      disposable.dispose();
    }
    const doc = watched(lines);
    window.activeTextEditor = { document: doc, selections: [{}] };
    fireDidChangeTextDocument(change(doc, { line: 2, character: 2 }, '  '));
    expect(executedCommands).toEqual([]);
  });
});

/** `|` の位置にマウスを乗せたときのホバー。 */
function hoverOf(format: 'yaml' | 'json', lines: readonly string[]): vscode.Hover | undefined {
  const line = lines.findIndex((text) => text.includes('|'));
  const character = lines[line]!.indexOf('|');
  const text = lines.map((value, i) => (i === line ? value.replace('|', '') : value));
  return hoverAt(format, document(text), { line, character });
}

/** ホバーの Markdown の本文。 */
function hoverText(hover: vscode.Hover | undefined): string | undefined {
  const [contents] = Array.isArray(hover?.contents) ? hover.contents : [hover?.contents];
  return contents instanceof MarkdownString ? contents.value : undefined;
}

const DOCS_LINK = '[Kiro documentation: Permissions](https://kiro.dev/docs/permissions/)';

describe('hoverAt', () => {
  it('capability の値に、補完と同じ説明とドキュメントへのリンクを出す', () => {
    const hover = hoverOf('yaml', ['rules:', '  - capability: bui|ltin']);
    expect(hoverText(hover)).toBe(
      ['**builtin** — meta capability', 'All built-in tools.', DOCS_LINK].join('\n\n'),
    );
    expect(hover!.range).toMatchObject({
      start: { line: 1, character: 16 },
      end: { line: 1, character: 23 },
    });
    expect(hoverText(hoverOf('yaml', ['rules:', '  - capability: a|ll # all tools']))).toContain(
      'Every capability except `sandbox_network`.',
    );
  });

  it('説明文のない capability は、名前とリンクだけ', () => {
    expect(hoverText(hoverOf('yaml', ['rules:', '  - capability: con|text']))).toBe(
      ['**context**', DOCS_LINK].join('\n\n'),
    );
  });

  it('キーと effect の値にも出す', () => {
    expect(hoverText(hoverOf('yaml', ['ru|les:']))).toContain('**rules** — list of rules');
    expect(
      hoverText(hoverOf('yaml', ['rules:', '  - capability: shell', '    eff|ect: deny'])),
    ).toContain('**effect** — required');
    expect(
      hoverText(hoverOf('yaml', ['rules:', '  - capability: shell', '    effect: de|ny'])),
    ).toContain('`deny > ask > allow`');
  });

  it('引用符で囲んだ値と、JSON の値でも引用符を外して引く', () => {
    expect(hoverText(hoverOf('yaml', ['rules:', '  - capability: "fs_r|ead"']))).toContain(
      '**fs_read**',
    );
    expect(hoverText(hoverOf('json', ['{"rules": [{"capability": "mc|p"}]}']))).toContain(
      '**mcp** — MCP tools',
    );
    expect(
      hoverText(hoverOf('json', ['{"rules": [{"capability": "shell", "eff|ect": "ask"}]}'])),
    ).toContain('**effect**');
  });

  it('未知の値、パターン、対象外の位置では出さない', () => {
    expect(hoverOf('yaml', ['rules:', '  - capability: netw|ork'])).toBeUndefined();
    expect(hoverOf('yaml', ['rules:', '  - unkn|own: x'])).toBeUndefined();
    expect(
      hoverOf('yaml', ['rules:', '  - capability: shell', '    match:', '      - "git |*"']),
    ).toBeUndefined();
    expect(hoverOf('yaml', ['# rul|es'])).toBeUndefined();
  });
});

describe('registerCompletion のホバー', () => {
  it('YAML と JSON のホバーを、補完と同じ selector で登録し、dispose で解放する', () => {
    const disposables = register();
    expect(registeredHoverProviders.map((provider) => provider.selector)).toEqual([
      completionSelector('yaml', home),
      completionSelector('json', home),
    ]);

    const provider = registeredHoverProviders[0]!.provider;
    if (!isHoverProvider(provider)) {
      throw new Error('provideHover is missing');
    }
    const hover = provider.provideHover(document(['rules:', '  - capability: all']), {
      line: 1,
      character: 17,
    });
    expect(hover).toMatchObject({ range: { start: { character: 16 } } });

    for (const disposable of disposables) {
      disposable.dispose();
    }
    expect(registeredHoverProviders).toHaveLength(0);
  });
});
