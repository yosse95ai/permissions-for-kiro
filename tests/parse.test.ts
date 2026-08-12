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
    expect(result.topLevelShape).toBe('mapping');
    expect(result.rulesKey).toBe('ok');
    expect(result.rules).toHaveLength(1);

    const rule = result.rules[0]!;
    expect(rule.index).toBe(0);
    expect(rule.capability).toBe('shell');
    expect(rule.capabilityRaw).toBe('shell');
    expect(rule.effect).toBe('allow');
    expect(rule.line).toBe(1);
    expect(rule.matchShape).toBe('list');
    expect(rule.unknownFields).toEqual([]);
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

  it('match が省略されている場合は shape が omitted になる', () => {
    const text = ['rules:', '  - capability: web_fetch', '    effect: allow'].join('\n');

    const rule = parsePermissions(text).rules[0]!;

    expect(rule.matchShape).toBe('omitted');
    expect(rule.matches).toEqual([]);
  });

  it('match が単一文字列の場合も内容は読むが shape は scalar になる', () => {
    // **Kiro ではこの書き方は fatal**（memory.md 3.4）。判定は validate.ts が行うので、
    // ここでは形の事実だけを記録し、内容は表示のために保持する。
    const text = ['rules:', '  - capability: shell', '    effect: deny', '    match: sudo*'].join(
      '\n',
    );

    const rule = parsePermissions(text).rules[0]!;

    expect(rule.matchShape).toBe('scalar');
    expect(rule.matches).toEqual([{ pattern: 'sudo*', line: 3 }]);
  });

  it('exclude も match と同じ形で読む', () => {
    const text = [
      'rules:',
      '  - capability: fs_write',
      '    effect: allow',
      '    match:',
      '      - "**"',
      '    exclude:',
      '      - .env',
    ].join('\n');

    const rule = parsePermissions(text).rules[0]!;

    expect(rule.exclude.shape).toBe('list');
    expect(rule.exclude.patterns).toEqual([{ pattern: '.env', line: 6 }]);
  });

  it('未知のキーを記録する（Kiro では fatal になる）', () => {
    const text = [
      'rules:',
      '  - capability: shell',
      '    effect: allow',
      '    mach:',
      '      - x',
    ].join('\n');

    const rule = parsePermissions(text).rules[0]!;

    expect(rule.unknownFields).toEqual(['mach']);
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
    expect(rule.matchShape).toBe('omitted');
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
    it('空文字列は topLevelShape が empty になる', () => {
      // **Kiro は空ファイルを fail closed 扱いする**（`yaml.parse('')` が null になるため）。
      // その判定は validate.ts が行う。
      const result = parsePermissions('');

      expect(result.rules).toEqual([]);
      expect(result.topLevelShape).toBe('empty');
      expect(result.errors).toEqual([]);
    });

    it('空白のみ・コメントのみも empty', () => {
      expect(parsePermissions('   \n\n  ').topLevelShape).toBe('empty');
      expect(parsePermissions('# just a comment\n').topLevelShape).toBe('empty');
    });

    it('トップレベルがマッピングでない場合は other', () => {
      expect(parsePermissions('- a\n- b\n').topLevelShape).toBe('other');
      expect(parsePermissions('just a string\n').topLevelShape).toBe('other');
    });

    it('rules キーが無い場合は rulesKey が missing', () => {
      const result = parsePermissions('something: else\n');

      expect(result.rules).toEqual([]);
      expect(result.topLevelShape).toBe('mapping');
      expect(result.rulesKey).toBe('missing');
      expect(result.errors).toEqual([]);
    });

    it('rules がリストでない場合は not-a-list', () => {
      const result = parsePermissions('rules: not-a-list\n');

      expect(result.rules).toEqual([]);
      expect(result.rulesKey).toBe('not-a-list');
    });

    it('rules の要素がマッピングでない場合は位置と行を記録する', () => {
      const text = ['rules:', '  - just-a-string', '  - capability: shell'].join('\n');

      const result = parsePermissions(text);

      expect(result.rules).toHaveLength(1);
      expect(result.nonMappingRules).toEqual([{ index: 0, line: 1 }]);
      // 残ったルールは YAML 上の位置を保持する。
      expect(result.rules[0]!.index).toBe(1);
    });

    it('capability / effect が読めない場合は UNKNOWN になり raw は undefined', () => {
      const text = ['rules:', '  - match:', '      - foo'].join('\n');

      const rule = parsePermissions(text).rules[0]!;

      expect(rule.capability).toBe(UNKNOWN);
      expect(rule.capabilityRaw).toBeUndefined();
      expect(rule.effect).toBe(UNKNOWN);
      expect(rule.effectRaw).toBeUndefined();
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

    it('数値や真偽値の capability は表示はするが raw には入れない', () => {
      // **Kiro は文字列でない capability を fatal 扱いする**ため、表示用の値と
      // 規則判定用の値を分けている。
      const text = ['rules:', '  - capability: 123', '    effect: true'].join('\n');

      const rule = parsePermissions(text).rules[0]!;

      expect(rule.capability).toBe('123');
      expect(rule.capabilityRaw).toBeUndefined();
      expect(rule.effect).toBe('true');
      expect(rule.effectRaw).toBeUndefined();
    });

    it('match がマッピングの場合は shape が other になる', () => {
      const text = ['rules:', '  - capability: shell', '    match:', '      key: value'].join('\n');

      const rule = parsePermissions(text).rules[0]!;

      expect(rule.matchShape).toBe('other');
      expect(rule.matches).toEqual([]);
    });

    it('exclude がマッピングの場合も other になる', () => {
      const text = ['rules:', '  - capability: shell', '    exclude:', '      key: value'].join(
        '\n',
      );

      expect(parsePermissions(text).rules[0]!.exclude.shape).toBe('other');
    });

    it('capability が null の場合は UNKNOWN になる', () => {
      // `capability:` と書いて値を書かなかったケース。
      const text = ['rules:', '  - capability:', '    effect: allow'].join('\n');

      const rule = parsePermissions(text).rules[0]!;

      expect(rule.capability).toBe(UNKNOWN);
      expect(rule.capabilityRaw).toBeUndefined();
    });

    it('match の要素に文字列でないものがあれば記録する', () => {
      const text = ['rules:', '  - capability: shell', '    match:', '      - 42'].join('\n');

      const rule = parsePermissions(text).rules[0]!;

      expect(rule.hasNonStringMatchEntry).toBe(true);
      // 内容は表示のために残す。
      expect(rule.matches).toEqual([{ pattern: '42', line: 3 }]);
    });
  });
});
