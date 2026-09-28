import { describe, expect, it } from 'vitest';

import {
  type CompletionRequest,
  completionRequest,
  cursorAfterWhitespace,
  type CursorPosition,
  isBelowEmptyYamlList,
  jsonCompletionRequest,
  yamlCompletionRequest,
} from '../src/completionContext';

/** カーソルの位置を表す印。テストの入力には `|` を含めない。 */
const CURSOR = '|';

/**
 * `|` でカーソルの位置を示したテキストを、行の配列とカーソル位置に分ける。
 *
 * 期待値の列番号を数えやすいように、入力は行の配列で受ける。
 */
function at(lines: readonly string[]): { lines: string[]; position: CursorPosition } {
  const line = lines.findIndex((text) => text.includes(CURSOR));
  if (line === -1) {
    throw new Error('cursor marker is missing');
  }
  const character = lines[line]!.indexOf(CURSOR);
  return {
    lines: lines.map((text, i) => (i === line ? text.replace(CURSOR, '') : text)),
    position: { line, character },
  };
}

function yaml(lines: readonly string[]): CompletionRequest | undefined {
  const { lines: text, position } = at(lines);
  return yamlCompletionRequest(text, position);
}

function below(lines: readonly string[]): boolean {
  const { lines: text, position } = at(lines);
  return isBelowEmptyYamlList(text, position);
}

function json(lines: readonly string[]): CompletionRequest | undefined {
  const { lines: text, position } = at(lines);
  return jsonCompletionRequest(text, position);
}

describe('yamlCompletionRequest（基本の位置）', () => {
  it('空ファイルの先頭はトップレベルのキー', () => {
    expect(yaml(['|'])).toEqual({
      site: { kind: 'top-level-key', present: [], colonAfter: false },
      replace: { start: 0, end: 0 },
    });
  });

  it('1 文字目のトップレベルのキー', () => {
    expect(yaml(['r|'])).toEqual({
      site: { kind: 'top-level-key', present: [], colonAfter: false },
      replace: { start: 0, end: 1 },
    });
  });

  it('`- ` の直後はルールのキー', () => {
    expect(yaml(['rules:', '  - |'])).toEqual({
      site: { kind: 'rule-key', present: [], colonAfter: false },
      replace: { start: 4, end: 4 },
    });
  });

  it('ルールのキーを 1 文字', () => {
    expect(yaml(['rules:', '  - c|'])).toEqual({
      site: { kind: 'rule-key', present: [], colonAfter: false },
      replace: { start: 4, end: 5 },
    });
  });

  it('`capability: ` の直後は capability の値', () => {
    expect(yaml(['rules:', '  - capability: |'])).toEqual({
      site: { kind: 'capability-value' },
      replace: { start: 16, end: 16 },
    });
  });

  it('capability の値を 1 文字', () => {
    expect(yaml(['rules:', '  - capability: s|'])).toEqual({
      site: { kind: 'capability-value' },
      replace: { start: 16, end: 17 },
    });
  });

  it('2 つ目のキーでは、書かれたキーを present に入れる', () => {
    expect(yaml(['rules:', '  - capability: shell', '    e|'])).toEqual({
      site: { kind: 'rule-key', present: ['capability'], colonAfter: false, capability: 'shell' },
      replace: { start: 4, end: 5 },
    });
  });

  it('`effect: ` の直後は effect の値', () => {
    expect(yaml(['rules:', '  - capability: shell', '    effect: |'])).toEqual({
      site: { kind: 'effect-value' },
      replace: { start: 12, end: 12 },
    });
  });

  it('`match:` の要素は、同じルールの capability に合ったパターン', () => {
    expect(
      yaml(['rules:', '  - capability: shell', '    effect: allow', '    match:', '      - |']),
    ).toEqual({
      site: { kind: 'pattern', list: 'match', capability: 'shell' },
      replace: { start: 8, end: 8 },
    });
  });

  it('`match:` の 2 つ目の要素も、ルールの `-` と取り違えない', () => {
    expect(
      yaml(['rules:', '  - capability: shell', '    match:', '      - git *', '      - |']),
    ).toEqual({
      site: { kind: 'pattern', list: 'match', capability: 'shell' },
      replace: { start: 8, end: 8 },
    });
  });

  it('2 つ目のルールのキーは、1 つ目のルールのキーに引きずられない', () => {
    expect(yaml(['rules:', '  - capability: shell', '    effect: allow', '  - |'])).toEqual({
      site: { kind: 'rule-key', present: [], colonAfter: false },
      replace: { start: 4, end: 4 },
    });
  });

  it('`match:` を先に書いたルールでも、後ろの capability を拾う', () => {
    expect(
      yaml(['rules:', '  - effect: deny', '    match:', '      - |', '    capability: fs_read']),
    ).toEqual({
      site: { kind: 'pattern', list: 'match', capability: 'fs_read' },
      replace: { start: 8, end: 8 },
    });
  });

  it('コメントの中では出さない', () => {
    expect(yaml(['# c|'])).toBeUndefined();
    expect(yaml(['rules:', '  - capability: shell # c|'])).toBeUndefined();
  });
});

describe('yamlCompletionRequest（手順ごとの境界）', () => {
  it('`:` の直後（空白を打つ前）では出さない', () => {
    expect(yaml(['rules:', '  - capability:|'])).toBeUndefined();
    expect(yaml(['rules:|'])).toBeUndefined();
  });

  it('`-` の直後（空白を打つ前）では出さない', () => {
    expect(yaml(['rules:', '  -|'])).toBeUndefined();
    expect(yaml(['rules:', '  - capability: shell', '    match:', '      -|'])).toBeUndefined();
  });

  describe('フロースタイルでは出さない', () => {
    it('値がフロー', () => {
      expect(yaml(['rules:', '  - capability: shell', '    effect: [|'])).toBeUndefined();
      expect(yaml(['rules:', '  - capability: {|'])).toBeUndefined();
    });

    it('`match:` の値がフロー', () => {
      expect(yaml(['rules:', '  - capability: shell', '    match: ["g|'])).toBeUndefined();
    });

    it('`match: [...]` の下に書いた `- ` は `match` の要素ではない', () => {
      expect(
        yaml(['rules:', '  - capability: shell', '    match: ["git *"]', '      - |']),
      ).toBeUndefined();
    });

    it('要素がフロー', () => {
      expect(yaml(['rules:', '  - capability: shell', '    match:', '      - [|'])).toBeUndefined();
    });

    it('`rules` 全体がフロー', () => {
      expect(yaml(['rules: [{capability: s|'])).toBeUndefined();
    });
  });

  describe('空白だけの行は、カーソルの列で所属先を決める', () => {
    it('キーの列ならルールのキー', () => {
      expect(yaml(['rules:', '  - capability: shell', '    |'])).toEqual({
        site: { kind: 'rule-key', present: ['capability'], colonAfter: false, capability: 'shell' },
        replace: { start: 4, end: 4 },
      });
    });

    it('ルールの列や、それより深い列では出さない', () => {
      expect(yaml(['rules:', '  - capability: shell', '  |'])).toBeUndefined();
      expect(yaml(['rules:', '  - capability: shell', '      |'])).toBeUndefined();
    });

    it('トップレベルは 0 列目だけ', () => {
      expect(yaml(['|', 'rules:'])).toEqual({
        site: { kind: 'top-level-key', present: ['rules'], colonAfter: false },
        replace: { start: 0, end: 0 },
      });
      expect(yaml(['  |'])).toBeUndefined();
    });
  });

  describe('`rules:` や `match:` と同じ列に `-` を書く書き方', () => {
    it('ルールのキー', () => {
      expect(yaml(['rules:', '- capability: shell', '  e|'])).toEqual({
        site: { kind: 'rule-key', present: ['capability'], colonAfter: false, capability: 'shell' },
        replace: { start: 2, end: 3 },
      });
    });

    it('`match:` の要素', () => {
      expect(yaml(['rules:', '- capability: shell', '  match:', '  - |'])).toEqual({
        site: { kind: 'pattern', list: 'match', capability: 'shell' },
        replace: { start: 4, end: 4 },
      });
    });
  });

  it('`-` だけの行で始まるルールは、次の行からキーの列を決める', () => {
    expect(yaml(['rules:', '  -', '    capability: shell', '    e|'])).toEqual({
      site: { kind: 'rule-key', present: ['capability'], colonAfter: false, capability: 'shell' },
      replace: { start: 4, end: 5 },
    });
  });

  it('`exclude:` の要素', () => {
    expect(yaml(['rules:', '  - capability: mcp', '    exclude:', '      - my-server/|'])).toEqual({
      site: { kind: 'pattern', list: 'exclude', capability: 'mcp' },
      replace: { start: 8, end: 18 },
    });
  });

  it('capability がないルールのパターンは capability を undefined にする', () => {
    expect(yaml(['rules:', '  - effect: deny', '    match:', '      - |'])).toEqual({
      site: { kind: 'pattern', list: 'match', capability: undefined },
      replace: { start: 8, end: 8 },
    });
  });

  it('capability の値の引用符とコメントを取り除く', () => {
    expect(
      yaml(['rules:', '  - capability: "fs_read" # reads', '    match:', '      - |']),
    ).toMatchObject({ site: { kind: 'pattern', capability: 'fs_read' } });
  });

  describe('置換範囲', () => {
    it('キーの名前だけを直しているときは colonAfter にし、キーの終わりまで置き換える', () => {
      expect(yaml(['rules:', '  - capa|bility: shell'])).toEqual({
        site: { kind: 'rule-key', present: [], colonAfter: true, capability: 'shell' },
        replace: { start: 4, end: 14 },
      });
    });

    it('値は行末まで置き換え、行末のコメントは残す', () => {
      expect(yaml(['rules:', '  - capability: sh| # note'])).toEqual({
        site: { kind: 'capability-value' },
        replace: { start: 16, end: 18 },
      });
    });

    it('引用符で始まる値は、開き引用符から置き換える', () => {
      expect(yaml(['rules:', '  - capability: "s|"'])).toEqual({
        site: { kind: 'capability-value' },
        replace: { start: 16, end: 19 },
      });
    });

    it('パターンは `- ` の直後から行末まで置き換える', () => {
      expect(
        yaml(['rules:', '  - capability: fs_read', '    match:', '      - "**/.e|"']),
      ).toMatchObject({ replace: { start: 8, end: 15 } });
    });
  });

  it('プレーンスカラーの中の引用符は引用符として扱わない（` #` はコメント）', () => {
    expect(
      yaml(['rules:', '  - capability: shell', '    match:', '      - git commit -m "a # b|"']),
    ).toBeUndefined();
  });

  it('キーの位置に、キーにならない文字を書いているときは出さない', () => {
    expect(yaml(['rules:', '  - capability: shell', '    "g|'])).toBeUndefined();
    expect(yaml(['rules:', '  - capability: shell', '    e-|'])).toBeUndefined();
  });

  it('capability / effect 以外のキーの値では出さない', () => {
    expect(yaml(['rules:', '  - capability: shell', '    match: |'])).toBeUndefined();
    expect(yaml(['rules:', '  - capability: shell', '    unknown: |'])).toBeUndefined();
  });

  it('キーの列より深い、`-` でない行では出さない', () => {
    expect(yaml(['rules:', '  - capability: shell', '      x|'])).toBeUndefined();
  });

  it('`match:` / `exclude:` 以外のキーの下の `- ` では出さない', () => {
    expect(
      yaml(['rules:', '  - capability: shell', '    effect: deny', '      - |']),
    ).toBeUndefined();
  });

  it('キーの列より浅い `-` では出さない', () => {
    expect(yaml(['rules:', '  - capability: shell', '   - |'])).toBeUndefined();
  });

  it('ルールより前の位置では出さない', () => {
    expect(yaml(['rules:', '  |', '  - capability: shell'])).toBeUndefined();
    expect(yaml(['rules:', '  capability: x|'])).toBeUndefined();
    expect(yaml(['rules:', '  |'])).toBeUndefined();
  });

  it('`rules:` の外に出たら、トップレベルとして扱う', () => {
    expect(yaml(['rules:', '  - capability: shell', 'r|'])).toEqual({
      site: { kind: 'top-level-key', present: ['rules'], colonAfter: false },
      replace: { start: 0, end: 1 },
    });
  });

  it('`rules:` の行でキーを直しているときは、自分の行を present に入れない', () => {
    expect(yaml(['ru|les:', '  - capability: shell'])).toEqual({
      site: { kind: 'top-level-key', present: [], colonAfter: true },
      replace: { start: 0, end: 5 },
    });
  });

  it('トップレベルの値や、インデントされた行・`-` の行では出さない', () => {
    expect(yaml(['rules: |'])).toBeUndefined();
    expect(yaml(['  r|'])).toBeUndefined();
    expect(yaml(['- |'])).toBeUndefined();
  });

  describe('引用符の中の `#` はコメントではない', () => {
    it('二重引用符（エスケープを含む）', () => {
      expect(
        yaml(['rules:', '  - capability: shell', '    match:', '      - "a\\" # b|"']),
      ).toMatchObject({ site: { kind: 'pattern' } });
    });

    it("単一引用符（`''` を含む）", () => {
      expect(
        yaml(['rules:', '  - capability: shell', '    match:', "      - 'it''s # b|'"]),
      ).toMatchObject({ site: { kind: 'pattern' } });
    });
  });

  it('タブの後ろの `#` もコメント', () => {
    expect(yaml(['rules:', '  - capability: shell\t# c|'])).toBeUndefined();
  });

  it('キーとして読めない書き方の値では出さない', () => {
    expect(yaml(['rules:', '  - capability: shell', '    e-x: |'])).toBeUndefined();
  });

  it('`match:` の要素の行は present に入れない', () => {
    expect(
      yaml(['rules:', '  - capability: shell', '    match:', '      - git *', '    |']),
    ).toEqual({
      site: {
        kind: 'rule-key',
        present: ['capability', 'match'],
        colonAfter: false,
        capability: 'shell',
      },
      replace: { start: 4, end: 4 },
    });
  });

  it('capability の値が空なら undefined にする', () => {
    expect(yaml(['rules:', '  - capability:', '    match:', '      - |'])).toMatchObject({
      site: { kind: 'pattern', capability: undefined },
    });
  });

  it('`match:` と要素の間の空行とコメントは読み飛ばす', () => {
    expect(
      yaml(['rules:', '  - capability: shell', '    match:', '', '    # note', '      - |']),
    ).toMatchObject({ site: { kind: 'pattern', list: 'match', capability: 'shell' } });
  });

  it('`-` だけの行のあとの空行とコメントは、キーの列を決めるときに読み飛ばす', () => {
    expect(
      yaml(['rules:', '  -', '', '    # note', '    capability: shell', '    e|']),
    ).toMatchObject({ site: { kind: 'rule-key', present: ['capability'] } });
  });

  describe('isBelowEmptyYamlList', () => {
    it('値のない match: / exclude: のすぐ下の、キーと同じ列なら true', () => {
      expect(below(['rules:', '  - capability: shell', '    match:', '    |'])).toBe(true);
      expect(below(['rules:', '  - capability: shell', '    exclude: # note', '    |'])).toBe(true);
      expect(below(['rules:', '  - match:', '    |'])).toBe(true);
      // 空行とコメントは読み飛ばす
      expect(below(['rules:', '  - capability: shell', '    match:', '', '    # x', '    |'])).toBe(
        true,
      );
    });

    it('それ以外は false', () => {
      expect(below(['rules:', '  - capability: shell', '    match: ["a"]', '    |'])).toBe(false);
      expect(below(['rules:', '  - capability: shell', '    effect: deny', '    |'])).toBe(false);
      expect(below(['rules:', '  - capability: shell', '    match:', '  |'])).toBe(false);
      expect(below(['|'])).toBe(false);
    });
  });

  describe('cursorAfterWhitespace', () => {
    it('同じ行への空白の挿入は、その後ろの列', () => {
      expect(cursorAfterWhitespace({ line: 2, character: 2 }, '  ')).toEqual({
        line: 2,
        character: 4,
      });
    });

    it('改行を含む挿入は、最後の行の空白の後ろ', () => {
      expect(cursorAfterWhitespace({ line: 1, character: 19 }, '\n    ')).toEqual({
        line: 2,
        character: 4,
      });
      expect(cursorAfterWhitespace({ line: 1, character: 19 }, '\r\n\t')).toEqual({
        line: 2,
        character: 1,
      });
    });

    it('空白以外を含むか、空の挿入なら undefined', () => {
      expect(cursorAfterWhitespace({ line: 0, character: 0 }, '')).toBeUndefined();
      expect(cursorAfterWhitespace({ line: 0, character: 0 }, ' e')).toBeUndefined();
    });
  });

  it('CRLF で分割しただけの行でも判定できる', () => {
    expect(yamlCompletionRequest(['rules:\r', '  - c'], { line: 1, character: 5 })).toEqual({
      site: { kind: 'rule-key', present: [], colonAfter: false },
      replace: { start: 4, end: 5 },
    });
  });

  it('範囲外の行では出さない', () => {
    expect(yamlCompletionRequest(['rules:'], { line: 3, character: 0 })).toBeUndefined();
  });
});

describe('jsonCompletionRequest（基本の位置）', () => {
  it('トップレベルの空の文字列はトップレベルのキー', () => {
    expect(json(['{', '  "|"'])).toEqual({
      site: { kind: 'top-level-key', present: [], colonAfter: false },
      replace: { start: 2, end: 4 },
    });
  });

  it('ルールの中の空の文字列はルールのキー', () => {
    expect(json(['{"rules": [{"|"}]}'])).toEqual({
      site: { kind: 'rule-key', present: [], colonAfter: false },
      replace: { start: 12, end: 14 },
    });
  });

  it('capability の値', () => {
    expect(json(['{"rules": [{"capability": "|"}]}'])).toEqual({
      site: { kind: 'capability-value' },
      replace: { start: 26, end: 28 },
    });
  });

  it('effect の値', () => {
    expect(json(['{"rules": [{"capability": "shell", "effect": "|"}]}'])).toEqual({
      site: { kind: 'effect-value' },
      replace: { start: 45, end: 47 },
    });
  });

  it('2 つ目のルールのキーは、そのルールのキーだけを present に入れる', () => {
    expect(
      json(['{"rules": [{"capability": "shell", "effect": "ask"}, {"effect": "deny", "|"}]}']),
    ).toEqual({
      site: { kind: 'rule-key', present: ['effect'], colonAfter: false },
      replace: { start: 72, end: 74 },
    });
  });
});

describe('jsonCompletionRequest（境界）', () => {
  it('パターンは同じルールの capability を拾う（後ろに書かれていても）', () => {
    expect(json(['{"rules": [{"match": ["|"], "capability": "fs_read"}]}'])).toEqual({
      site: { kind: 'pattern', list: 'match', capability: 'fs_read' },
      replace: { start: 22, end: 24 },
    });
    expect(json(['{"rules": [{"capability": "mcp", "exclude": ["a", "|"]}]}'])).toEqual({
      site: { kind: 'pattern', list: 'exclude', capability: 'mcp' },
      replace: { start: 50, end: 52 },
    });
  });

  it('capability が文字列でなければ undefined にする', () => {
    expect(json(['{"rules": [{"capability": 1, "match": ["|"]}]}'])).toMatchObject({
      site: { kind: 'pattern', capability: undefined },
    });
  });

  it('複数行に分けて書いた JSON でも、カーソルの行の列で範囲を返す', () => {
    expect(
      json(['{', '  "rules": [', '    {', '      "capability": "shell",', '      "e|"']),
    ).toEqual({
      site: { kind: 'rule-key', present: ['capability'], colonAfter: false, capability: 'shell' },
      replace: { start: 6, end: 9 },
    });
  });

  it('CRLF で分割しただけの行でも位置がずれない', () => {
    expect(
      jsonCompletionRequest(['{\r', '  "rules": [{"capability": ""}]\r', '}'], {
        line: 1,
        character: 28,
      }),
    ).toEqual({ site: { kind: 'capability-value' }, replace: { start: 27, end: 29 } });
  });

  it('閉じ引用符のない書きかけの文字列も範囲に入れる', () => {
    expect(json(['{"rules": [{"ca|'])).toEqual({
      site: { kind: 'rule-key', present: [], colonAfter: false },
      replace: { start: 12, end: 15 },
    });
    expect(json(['{"rules": [{"capability": "s|'])).toEqual({
      site: { kind: 'capability-value' },
      replace: { start: 26, end: 28 },
    });
  });

  it('キーの名前だけを直しているときは colonAfter にし、自分のキーは present に入れない', () => {
    expect(json(['{"rules": [{"capa|bility": "shell", "effect": "ask"}]}'])).toEqual({
      site: { kind: 'rule-key', present: ['effect'], colonAfter: true, capability: 'shell' },
      replace: { start: 12, end: 24 },
    });
  });

  it('引用符の外でも、キーや値を書き始める位置なら空の範囲で返す', () => {
    expect(json(['{|}'])).toEqual({
      site: { kind: 'top-level-key', present: [], colonAfter: false },
      replace: { start: 1, end: 1 },
    });
    expect(json(['{"rules": [{"capability": |}]}'])).toEqual({
      site: { kind: 'capability-value' },
      replace: { start: 26, end: 26 },
    });
    expect(json(['{"rules": [{"capability": "shell", "match": [|]}]}'])).toMatchObject({
      site: { kind: 'pattern', list: 'match' },
      replace: { start: 45, end: 45 },
    });
  });

  it('文字列を閉じたあとや、文字列でない値の中では出さない', () => {
    expect(json(['{"rules": [{"capability": "shell"|}]}'])).toBeUndefined();
    expect(json(['{"rules": [{"capability": "shell" |}]}'])).toBeUndefined();
    expect(json(['{"rules": [{"capability": tr|}]}'])).toBeUndefined();
    expect(json(['{"rules": [{"capability": 1|}]}'])).toBeUndefined();
  });

  it('エスケープされた引用符で終わる文字列は、まだ閉じていないとみなす', () => {
    expect(json(['{"rules": [{"capability": "a\\"|'])).toMatchObject({
      site: { kind: 'capability-value' },
    });
  });

  it('対象外の位置では出さない', () => {
    expect(json(['{"rules": |}'])).toBeUndefined();
    expect(json(['{"rules": [|]}'])).toBeUndefined();
    expect(json(['{"rules": "|"}'])).toBeUndefined();
    expect(json(['{"other": [{"|"}]}'])).toBeUndefined();
    expect(json(['{"rules": [{"match": {"|"}}]}'])).toBeUndefined();
    expect(json(['{"rules": [{"capability": "shell", "match": "|"}]}'])).toBeUndefined();
    expect(
      json(['{"rules": [{"capability": "shell", "effect": "ask", "x": "|"}]}']),
    ).toBeUndefined();
  });

  it('範囲外の行や、空のファイルでは出さない', () => {
    expect(jsonCompletionRequest(['{}'], { line: 2, character: 0 })).toBeUndefined();
    expect(json(['|'])).toBeUndefined();
  });
});

describe('completionRequest', () => {
  it('形式で YAML と JSON の判定を切り替える', () => {
    expect(completionRequest('yaml', ['r'], { line: 0, character: 1 })).toMatchObject({
      site: { kind: 'top-level-key' },
    });
    expect(completionRequest('json', ['{""}'], { line: 0, character: 2 })).toMatchObject({
      site: { kind: 'top-level-key' },
    });
    expect(completionRequest('json', ['r'], { line: 0, character: 1 })).toBeUndefined();
  });
});
