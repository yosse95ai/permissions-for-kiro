import { describe, expect, it } from 'vitest';

import {
  EFFECT_APPEARANCE,
  effectAppearance,
  EXCLUDE_APPEARANCE,
  exclusionSummary,
  formatParseError,
  hasPatternChildren,
  INACTIVE_APPEARANCE,
  isScopeInactive,
  MATCH_APPEARANCE,
  matchSummary,
  ruleAccessibilityLabel,
  ruleAppearance,
  ruleDescription,
  ruleStateOf,
  scopeDescription,
  SKIPPED_APPEARANCE,
  UNKNOWN_EFFECT_APPEARANCE,
} from '../src/display';
import type { ScopeContent } from '../src/model';
import type { ParseResult } from '../src/parse';
import { makeParseResult, makeRule, okValidation, validationOf } from './fixtures';

const rule = makeRule;

function parsed(overrides: Partial<ParseResult> = {}): ScopeContent {
  return { state: 'parsed', result: makeParseResult(overrides) };
}

describe('effectAppearance', () => {
  it('effect ごとに形の異なるアイコンを返す', () => {
    expect(effectAppearance('allow')).toEqual({
      icon: 'pass-filled',
      color: 'testing.iconPassed',
    });
    expect(effectAppearance('deny')).toEqual({ icon: 'circle-slash', color: 'errorForeground' });
    expect(effectAppearance('ask')).toEqual({ icon: 'ask', color: 'editorWarning.foreground' });
  });

  it('未知の effect は無彩色のアイコンにする', () => {
    expect(effectAppearance('whatever')).toEqual(UNKNOWN_EFFECT_APPEARANCE);
    expect(effectAppearance('(unspecified)')).toEqual(UNKNOWN_EFFECT_APPEARANCE);
  });
});

describe('matchSummary', () => {
  it('match 省略は all', () => {
    expect(matchSummary(rule({ matchShape: 'omitted' }))).toBe('all');
  });

  it('1 件でも件数にする（パターン文字列は子ノードに出るため）', () => {
    expect(
      matchSummary(rule({ matchShape: 'list', matches: [{ pattern: 'sudo*', line: 3 }] })),
    ).toBe('1 pattern');
  });

  it('複数なら件数', () => {
    expect(
      matchSummary(
        rule({
          matchShape: 'list',
          matches: [
            { pattern: 'a', line: 1 },
            { pattern: 'b', line: 2 },
          ],
        }),
      ),
    ).toBe('2 patterns');
  });

  it('`match: []` は 0 patterns', () => {
    expect(matchSummary(rule({ matchShape: 'list', matches: [] }))).toBe('0 patterns');
  });
});

describe('ruleDescription', () => {
  it('allow は effect を書かない（無標）', () => {
    const target = rule({
      effect: 'allow',
      matchShape: 'list',
      matches: Array.from({ length: 18 }, (_, i) => ({ pattern: `p${i}`, line: i })),
    });

    expect(ruleDescription(target)).toBe('18 patterns');
  });

  it('deny は effect を併記する', () => {
    const target = rule({
      effect: 'deny',
      matchShape: 'list',
      matches: [{ pattern: 'sudo*', line: 3 }],
    });

    expect(ruleDescription(target)).toBe('deny · 1 pattern');
  });

  it('ask も effect を併記する', () => {
    expect(ruleDescription(rule({ effect: 'ask', matchShape: 'omitted' }))).toBe('ask · all');
  });

  it('未知の effect は併記しない（allow と同じ扱い）', () => {
    expect(ruleDescription(rule({ effect: '(unspecified)', matchShape: 'omitted' }))).toBe('all');
  });
});

describe('ruleAccessibilityLabel', () => {
  it('視覚的に無標な allow も読み上げには含める', () => {
    const target = rule({
      effect: 'allow',
      matchShape: 'list',
      matches: Array.from({ length: 18 }, (_, i) => ({ pattern: `p${i}`, line: i })),
    });

    expect(ruleAccessibilityLabel(target)).toBe('shell, allow, 18 patterns');
  });

  it('deny も同じ形式', () => {
    const target = rule({
      effect: 'deny',
      matchShape: 'list',
      matches: [{ pattern: 'sudo*', line: 3 }],
    });

    expect(ruleAccessibilityLabel(target)).toBe('shell, deny, 1 pattern');
  });
});

describe('hasPatternChildren', () => {
  it('パターンが 1 件でも子を持つ（ツリー形式に統一する）', () => {
    expect(
      hasPatternChildren(rule({ matchShape: 'list', matches: [{ pattern: 'a', line: 1 }] })),
    ).toBe(true);
  });

  it('パターンが 1 件も無ければ子を持たない', () => {
    // `all`（match 省略 + exclude なし）だけが葉になる。
    expect(hasPatternChildren(rule({ matchShape: 'omitted' }))).toBe(false);
    expect(hasPatternChildren(rule({ matchShape: 'list', matches: [] }))).toBe(false);
  });

  it('2 件以上は子を持つ', () => {
    expect(
      hasPatternChildren(
        rule({
          matchShape: 'list',
          matches: [
            { pattern: 'a', line: 1 },
            { pattern: 'b', line: 2 },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('scopeDescription', () => {
  it('ファイルが無い場合は not set', () => {
    expect(scopeDescription({ state: 'missing' }, okValidation())).toBe('not set');
  });

  it('読み込みに失敗した場合は read error', () => {
    expect(scopeDescription({ state: 'read-error', message: 'EACCES' }, okValidation())).toBe(
      'read error',
    );
  });

  it('パースエラーがある場合は件数より優先して parse error', () => {
    const content = parsed({
      rules: [rule()],
      errors: [{ message: 'broken', line: 3, column: 0 }],
    });

    expect(scopeDescription(content, okValidation())).toBe('parse error');
  });

  it('ルール数を単数複数で出す', () => {
    expect(scopeDescription(parsed({ rules: [] }), okValidation())).toBe('0 rules');
    expect(scopeDescription(parsed({ rules: [rule()] }), okValidation())).toBe('1 rule');
    expect(scopeDescription(parsed({ rules: [rule(), rule()] }), okValidation())).toBe('2 rules');
  });

  it('fatal があれば not loaded を出す（件数より優先）', () => {
    const result = makeParseResult({ rules: [rule()], rulesKey: 'missing' });

    expect(scopeDescription({ state: 'parsed', result }, validationOf(result))).toBe('not loaded');
  });

  it('skip されたルールがあれば件数に併記する', () => {
    const result = makeParseResult({
      rules: [rule(), rule({ index: 1, capability: 'dev', capabilityRaw: 'dev' })],
    });

    expect(scopeDescription({ state: 'parsed', result }, validationOf(result))).toBe(
      '2 rules · 1 skipped',
    );
  });
});

describe('ruleAppearance', () => {
  it('効いているルールは effect のアイコン', () => {
    expect(ruleAppearance(rule({ effect: 'deny' }), 'active')).toEqual({
      icon: 'circle-slash',
      color: 'errorForeground',
    });
  });

  it('skip されたルールは警告アイコンに置き換える', () => {
    expect(ruleAppearance(rule({ effect: 'deny' }), 'skipped')).toEqual(SKIPPED_APPEARANCE);
  });

  it('読み込まれていないスコープのルールは無彩色にする', () => {
    const appearance = ruleAppearance(rule({ effect: 'allow' }), 'inactive');

    expect(appearance).toEqual(INACTIVE_APPEARANCE);
    // 色を付けないことが要点。allow の緑が残ると「許可されている」と誤読される。
    expect(appearance.color).toBeUndefined();
  });
});

describe('ruleDescription / ruleAccessibilityLabel の状態表示', () => {
  it('skipped を先頭に出す', () => {
    const target = rule({
      effect: 'deny',
      matchShape: 'list',
      matches: [{ pattern: 'x', line: 1 }],
    });

    expect(ruleDescription(target, 'skipped')).toBe('skipped · deny · 1 pattern');
  });

  it('inactive は description には出さない（スコープ行と親のアイコンで伝える）', () => {
    expect(ruleDescription(rule({ effect: 'deny' }), 'inactive')).toBe('deny · all');
  });

  it('読み上げには状態を文字で足す', () => {
    expect(ruleAccessibilityLabel(rule(), 'skipped')).toBe('shell, allow, all, skipped');
    expect(ruleAccessibilityLabel(rule(), 'inactive')).toBe('shell, allow, all, not loaded');
  });
});

function withExclude(patterns: string[], overrides = {}) {
  return rule({
    exclude: {
      patterns: patterns.map((pattern, i) => ({ pattern, line: i + 5 })),
      shape: 'list',
      hasNonStringEntry: false,
    },
    ...overrides,
  });
}

describe('exclude の表示', () => {
  it('exclude が無ければ description に出さない', () => {
    expect(exclusionSummary(rule())).toBeUndefined();
    expect(ruleDescription(rule())).toBe('all');
  });

  it('件数を単数複数で出す', () => {
    expect(exclusionSummary(withExclude(['.env']))).toBe('1 exclusion');
    expect(exclusionSummary(withExclude(['.env', '*.pem']))).toBe('2 exclusions');
  });

  it('match 省略と併用されたときに誤読を防ぐ', () => {
    // `all` だけだと「全部許可」に見えるが、実際は除外がある。
    expect(ruleDescription(withExclude(['.env']))).toBe('all · 1 exclusion');
  });

  it('match と併記する', () => {
    const target = withExclude(['.env'], {
      matchShape: 'list',
      matches: [{ pattern: '**', line: 3 }],
    });

    expect(ruleDescription(target)).toBe('1 pattern · 1 exclusion');
  });

  it('読み上げにも含める', () => {
    expect(ruleAccessibilityLabel(withExclude(['.env']))).toBe('shell, allow, all, 1 exclusion');
  });

  it('exclude があれば match が 1 件以下でも子ノードを作る', () => {
    // 子にしないと、除外の中身が完全に見えなくなる。
    expect(hasPatternChildren(withExclude(['.env']))).toBe(true);
    expect(
      hasPatternChildren(
        withExclude(['.env'], { matchShape: 'list', matches: [{ pattern: '**', line: 3 }] }),
      ),
    ).toBe(true);
  });

  it('match は緑、exclude は灰色（deny や not loaded の赤と混ざらないように）', () => {
    expect(MATCH_APPEARANCE).toEqual({ icon: 'gear', color: 'charts.green' });
    expect(EXCLUDE_APPEARANCE).toEqual({ icon: 'exclude', color: 'descriptionForeground' });
    // allow の緑とは別の ID にする。deny ルールの match 行も緑になるため。
    expect(MATCH_APPEARANCE.color).not.toBe(EFFECT_APPEARANCE.allow?.color);
  });
});

describe('isScopeInactive / ruleStateOf', () => {
  it('ファイルが無いスコープは inactive ではない', () => {
    expect(isScopeInactive({ state: 'missing' }, okValidation())).toBe(false);
  });

  it('パースエラーと fatal はどちらも inactive', () => {
    const broken = makeParseResult({ errors: [{ message: 'broken', line: 0, column: 0 }] });
    expect(isScopeInactive({ state: 'parsed', result: broken }, okValidation())).toBe(true);

    const noRules = makeParseResult({ rulesKey: 'missing' });
    expect(isScopeInactive({ state: 'parsed', result: noRules }, validationOf(noRules))).toBe(true);
  });

  it('スコープが inactive なら skip の有無に関わらず inactive', () => {
    const result = makeParseResult({
      rules: [rule({ capability: 'dev', capabilityRaw: 'dev' })],
    });

    expect(ruleStateOf(0, validationOf(result), true)).toBe('inactive');
    expect(ruleStateOf(0, validationOf(result), false)).toBe('skipped');
    expect(ruleStateOf(1, validationOf(result), false)).toBe('active');
  });
});

describe('formatParseError', () => {
  it('行番号を 1-based に直して表示する', () => {
    expect(formatParseError({ line: 3, message: 'Sequence item without - indicator' })).toBe(
      'Line 4: Sequence item without - indicator',
    );
  });

  // `yaml` パッケージが実際に返す形。説明文 + スニペット + キャレットの複数行で、
  // 末尾に `Line N:` と重複する位置情報が付く。
  const YAML_MESSAGE = [
    'Sequence item without - indicator at line 3, column 1:',
    '',
    '  - capability: shell',
    '   effect: allow',
    '^',
    '',
  ].join('\n');

  it('複数行のメッセージは 1 行目だけを使う', () => {
    expect(formatParseError({ line: 2, message: YAML_MESSAGE })).toBe(
      'Line 3: Sequence item without - indicator',
    );
  });

  it('末尾の位置情報を落とす', () => {
    expect(
      formatParseError({
        line: 2,
        message: 'Nested mappings are not allowed at line 3, column 12:',
      }),
    ).toBe('Line 3: Nested mappings are not allowed');
  });

  it('コロンが無い形の位置情報も落とす', () => {
    expect(formatParseError({ line: 0, message: 'Bad indentation at line 1, column 3' })).toBe(
      'Line 1: Bad indentation',
    );
  });

  it('行の途中にある line / column の記述は落とさない', () => {
    expect(
      formatParseError({
        line: 0,
        message: 'Tabs are not allowed at line 1, column 3 as indentation',
      }),
    ).toBe('Line 1: Tabs are not allowed at line 1, column 3 as indentation');
  });

  it('メッセージが空でも壊れない', () => {
    expect(formatParseError({ line: 0, message: '' })).toBe('Line 1: ');
  });
});
