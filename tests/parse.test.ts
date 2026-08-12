import { describe, expect, it } from 'vitest';

import { parsePermissions, UNKNOWN } from '../src/parse';

describe('parsePermissions', () => {
  it('capability / effect / match と行番号を読み取る', () => {
    const text = [
      'rules:', //                       line 0
      '  - capability: shell', //        line 1
      '    effect: allow', //            line 2
      '    match:', //                   line 3
      '      - npm run build', //        line 4
      '      - ls *', //                 line 5
    ].join('\n');

    const result = parsePermissions(text);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.rules).toHaveLength(1);

    const rule = result.rules[0]!;
    expect(rule.capability).toBe('shell');
    expect(rule.effect).toBe('allow');
    expect(rule.line).toBe(1);
    expect(rule.matchOmitted).toBe(false);
    expect(rule.matches).toEqual([
      { pattern: 'npm run build', line: 4 },
      { pattern: 'ls *', line: 5 },
    ]);
  });

  it('match の記載順を保つ（ソートしない）', () => {
    const text = [
      'rules:',
      '  - capability: shell',
      '    match:',
      '      - zzz',
      '      - aaa',
    ].join('\n');

    const patterns = parsePermissions(text).rules[0]!.matches.map((m) => m.pattern);

    expect(patterns).toEqual(['zzz', 'aaa']);
  });

  it('match が省略されている場合は matchOmitted になる', () => {
    const text = ['rules:', '  - capability: web_fetch', '    effect: allow'].join('\n');

    const rule = parsePermissions(text).rules[0]!;

    expect(rule.matchOmitted).toBe(true);
    expect(rule.matches).toEqual([]);
  });

  it('match が単一の文字列でも読める', () => {
    const text = ['rules:', '  - capability: shell', '    effect: deny', '    match: sudo*'].join(
      '\n',
    );

    const rule = parsePermissions(text).rules[0]!;

    expect(rule.matchOmitted).toBe(false);
    expect(rule.matches).toEqual([{ pattern: 'sudo*', line: 3 }]);
  });

  it('複数ルールをそれぞれの行番号付きで返す', () => {
    const text = [
      'rules:', //                        line 0
      '  - capability: shell', //         line 1
      '    effect: allow', //             line 2
      '  - capability: web_fetch', //     line 3
      '    effect: allow', //             line 4
      '  - capability: shell', //         line 5
      '    effect: deny', //              line 6
      '    match:', //                    line 7
      '      - sudo*', //                 line 8
    ].join('\n');

    const result = parsePermissions(text);

    expect(result.rules.map((r) => [r.capability, r.effect, r.line])).toEqual([
      ['shell', 'allow', 1],
      ['web_fetch', 'allow', 3],
      ['shell', 'deny', 5],
    ]);
    expect(result.rules[2]!.matches).toEqual([{ pattern: 'sudo*', line: 8 }]);
  });

  it('メタ capability `all` も普通のルールとして読む', () => {
    const text = ['rules:', '  - capability: all', '    effect: allow'].join('\n');

    const rule = parsePermissions(text).rules[0]!;

    expect(rule.capability).toBe('all');
    expect(rule.matchOmitted).toBe(true);
  });

  it('JSON 形式も同じパーサで読める', () => {
    const text = JSON.stringify(
      { rules: [{ capability: 'mcp', effect: 'allow', match: ['server/tool'] }] },
      null,
      2,
    );

    const result = parsePermissions(text);

    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.capability).toBe('mcp');
    expect(result.rules[0]!.matches[0]!.pattern).toBe('server/tool');
  });

  describe('異常系', () => {
    it('空文字列はルール 0 件で警告もなし', () => {
      const result = parsePermissions('');

      expect(result.rules).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('空白のみの場合もルール 0 件', () => {
      expect(parsePermissions('   \n\n  ').rules).toEqual([]);
    });

    it('rules キーが無い場合は警告する', () => {
      const result = parsePermissions('something: else\n');

      expect(result.rules).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.errors).toEqual([]);
    });

    it('rules がリストでない場合は警告する', () => {
      const result = parsePermissions('rules: not-a-list\n');

      expect(result.rules).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it('rules の要素がマッピングでない場合はスキップして警告する', () => {
      const text = ['rules:', '  - just-a-string', '  - capability: shell'].join('\n');

      const result = parsePermissions(text);

      expect(result.rules).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
    });

    it('capability / effect が読めない場合は UNKNOWN になる', () => {
      const text = ['rules:', '  - match:', '      - foo'].join('\n');

      const rule = parsePermissions(text).rules[0]!;

      expect(rule.capability).toBe(UNKNOWN);
      expect(rule.effect).toBe(UNKNOWN);
    });

    it('壊れた YAML は行・列・コード付きのエラーを返す', () => {
      const text = [
        'rules:', //                  line 0
        '  - capability: shell', //    line 1
        '   effect: allow', //         line 2（インデント不整合）
      ].join('\n');

      const result = parsePermissions(text);

      expect(result.rules).toEqual([]);
      expect(result.errors).toHaveLength(1);

      const error = result.errors[0]!;
      expect(error.code).toBe('MISSING_CHAR');
      expect(error.line).toBe(2); // 0-based
      expect(error.column).toBe(0); // 0-based
      expect(error.message).toBeTruthy();
    });

    it('代表的な構文エラーをそれぞれ検出する', () => {
      const cases: Array<[string, string, string]> = [
        ['タブによるインデント', 'rules:\n\t- capability: shell\n', 'TAB_AS_INDENT'],
        ['キーの重複', 'rules: []\nrules: []\n', 'DUPLICATE_KEY'],
        ['ハイフン抜け', 'rules:\n  - capability: shell\n  effect: allow\n', 'BAD_INDENT'],
        ['閉じていないフロー', 'rules: [\n  - capability: shell\n', 'BLOCK_IN_FLOW'],
      ];

      for (const [, text, expectedCode] of cases) {
        const result = parsePermissions(text);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.map((e) => e.code)).toContain(expectedCode);
      }
    });

    it('数値や真偽値の capability も文字列として扱う', () => {
      const text = ['rules:', '  - capability: 123', '    effect: true'].join('\n');

      const rule = parsePermissions(text).rules[0]!;

      expect(rule.capability).toBe('123');
      expect(rule.effect).toBe('true');
    });
  });
});
