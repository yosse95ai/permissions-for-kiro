import { describe, expect, it } from 'vitest';

import {
  effectAppearance,
  formatParseError,
  hasPatternChildren,
  matchSummary,
  ruleAccessibilityLabel,
  ruleDescription,
  scopeDescription,
  UNKNOWN_EFFECT_APPEARANCE,
} from '../src/display';
import type { ScopeContent } from '../src/model';
import type { ParseResult, PermissionRule } from '../src/parse';

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    capability: 'shell',
    effect: 'allow',
    line: 0,
    matches: [],
    matchOmitted: true,
    ...overrides,
  };
}

function parsed(overrides: Partial<ParseResult> = {}): ScopeContent {
  return {
    state: 'parsed',
    result: { rules: [], warnings: [], errors: [], ...overrides },
  };
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
    expect(matchSummary(rule({ matchOmitted: true }))).toBe('all');
  });

  it('1 件ならパターンそのもの', () => {
    expect(
      matchSummary(rule({ matchOmitted: false, matches: [{ pattern: 'sudo*', line: 3 }] })),
    ).toBe('sudo*');
  });

  it('複数なら件数', () => {
    expect(
      matchSummary(
        rule({
          matchOmitted: false,
          matches: [
            { pattern: 'a', line: 1 },
            { pattern: 'b', line: 2 },
          ],
        }),
      ),
    ).toBe('2 patterns');
  });

  it('`match: []` は 0 patterns', () => {
    expect(matchSummary(rule({ matchOmitted: false, matches: [] }))).toBe('0 patterns');
  });
});

describe('ruleDescription', () => {
  it('allow は effect を書かない（無標）', () => {
    const target = rule({
      effect: 'allow',
      matchOmitted: false,
      matches: Array.from({ length: 18 }, (_, i) => ({ pattern: `p${i}`, line: i })),
    });

    expect(ruleDescription(target)).toBe('18 patterns');
  });

  it('deny は effect を併記する', () => {
    const target = rule({
      effect: 'deny',
      matchOmitted: false,
      matches: [{ pattern: 'sudo*', line: 3 }],
    });

    expect(ruleDescription(target)).toBe('deny · sudo*');
  });

  it('ask も effect を併記する', () => {
    expect(ruleDescription(rule({ effect: 'ask', matchOmitted: true }))).toBe('ask · all');
  });

  it('未知の effect は併記しない（allow と同じ扱い）', () => {
    expect(ruleDescription(rule({ effect: '(unspecified)', matchOmitted: true }))).toBe('all');
  });
});

describe('ruleAccessibilityLabel', () => {
  it('視覚的に無標な allow も読み上げには含める', () => {
    const target = rule({
      effect: 'allow',
      matchOmitted: false,
      matches: Array.from({ length: 18 }, (_, i) => ({ pattern: `p${i}`, line: i })),
    });

    expect(ruleAccessibilityLabel(target)).toBe('shell, allow, 18 patterns');
  });

  it('deny も同じ形式', () => {
    const target = rule({
      effect: 'deny',
      matchOmitted: false,
      matches: [{ pattern: 'sudo*', line: 3 }],
    });

    expect(ruleAccessibilityLabel(target)).toBe('shell, deny, sudo*');
  });
});

describe('hasPatternChildren', () => {
  it('match 省略と 1 件以下は子を持たない', () => {
    expect(hasPatternChildren(rule({ matchOmitted: true }))).toBe(false);
    expect(
      hasPatternChildren(rule({ matchOmitted: false, matches: [{ pattern: 'a', line: 1 }] })),
    ).toBe(false);
    expect(hasPatternChildren(rule({ matchOmitted: false, matches: [] }))).toBe(false);
  });

  it('2 件以上は子を持つ', () => {
    expect(
      hasPatternChildren(
        rule({
          matchOmitted: false,
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
    expect(scopeDescription({ state: 'missing' })).toBe('not set');
  });

  it('読み込みに失敗した場合は read error', () => {
    expect(scopeDescription({ state: 'read-error', message: 'EACCES' })).toBe('read error');
  });

  it('パースエラーがある場合は件数より優先して parse error', () => {
    const content = parsed({
      rules: [rule()],
      errors: [{ message: 'broken', line: 3, column: 0 }],
    });

    expect(scopeDescription(content)).toBe('parse error');
  });

  it('ルール数を単数複数で出す', () => {
    expect(scopeDescription(parsed({ rules: [] }))).toBe('0 rules');
    expect(scopeDescription(parsed({ rules: [rule()] }))).toBe('1 rule');
    expect(scopeDescription(parsed({ rules: [rule(), rule()] }))).toBe('2 rules');
  });
});

describe('formatParseError', () => {
  it('行番号を 1-based に直して表示する', () => {
    expect(formatParseError({ line: 3, message: 'Sequence item without - indicator' })).toBe(
      'Line 4: Sequence item without - indicator',
    );
  });
});
