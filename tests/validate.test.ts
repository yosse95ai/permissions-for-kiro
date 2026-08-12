import { describe, expect, it } from 'vitest';

import { parsePermissions } from '../src/parse';
import { KNOWN_CAPABILITIES, validatePermissions } from '../src/validate';
import { makeParseResult, makeRule } from './fixtures';

/**
 * Kiro 本体の検証仕様（memory.md 3.4）を再現できているかを確認する。
 *
 * **fatal と non-fatal の区別が要点。** fatal は設定全体が読み込まれず fail closed になり、
 * non-fatal はそのルールだけが捨てられる。
 */

/** YAML から検証まで通す。実際の経路に近い形で確かめる。 */
function validateYaml(text: string, scope: 'user' | 'workspace' = 'user') {
  return validatePermissions(parsePermissions(text), scope);
}

const VALID = ['rules:', '  - capability: shell', '    effect: allow'].join('\n');

describe('正常系', () => {
  it('正しいルールは fatal も skip も出さない', () => {
    const validation = validateYaml(VALID);

    expect(validation.fatal).toEqual([]);
    expect(validation.skipped.size).toBe(0);
  });

  it('rules が空配列でも正常', () => {
    const validation = validateYaml('rules: []\n');

    expect(validation.fatal).toEqual([]);
  });

  it('既知の capability をすべて受け付ける', () => {
    // 落ちたものだけを集める。どの capability で失敗したかが失敗メッセージに出る。
    const rejected = KNOWN_CAPABILITIES.filter((capability) => {
      const text = ['rules:', `  - capability: ${capability}`, '    effect: allow'].join('\n');
      const validation = validateYaml(text);
      return validation.fatal.length > 0 || validation.skipped.size > 0;
    });

    expect(rejected).toEqual([]);
  });

  it('exclude を付けても正常', () => {
    const text = [
      'rules:',
      '  - capability: fs_write',
      '    effect: allow',
      '    match:',
      '      - "**"',
      '    exclude:',
      '      - .env',
    ].join('\n');

    expect(validateYaml(text).fatal).toEqual([]);
  });
});

describe('non-fatal（そのルールだけ skip される）', () => {
  it('未知の capability は skip される', () => {
    const text = [
      'rules:',
      '  - capability: shell',
      '    effect: allow',
      '  - capability: dev',
      '    effect: deny',
    ].join('\n');

    const validation = validateYaml(text);

    expect(validation.fatal).toEqual([]);
    expect(validation.skipped.size).toBe(1);
    // キーは rules 配列内の位置。
    expect(validation.skipped.get(1)?.message).toBe('Skipping rule 1: unknown capability "dev"');
  });

  it('skip されたルールの行番号を持つ（ジャンプ用）', () => {
    const text = ['rules:', '  - capability: dev', '    effect: deny'].join('\n');

    expect(validateYaml(text).skipped.get(0)?.line).toBe(1);
  });

  it('未知の capability のルールは、以降の検証に進まない（本体と同じ打ち切り）', () => {
    // effect も match も壊れているが、capability の時点で skip されるため fatal にならない。
    const text = ['rules:', '  - capability: dev', '    effect: nope', '    match: single'].join(
      '\n',
    );

    const validation = validateYaml(text);

    expect(validation.fatal).toEqual([]);
    expect(validation.skipped.size).toBe(1);
  });
});

describe('fatal（設定全体が読み込まれない）', () => {
  it('空ファイルは fatal', () => {
    // 本体は yaml.parse('') === null を「object でない」として落とす。
    const validation = validateYaml('');

    expect(validation.fatal).toEqual([{ message: 'Policy must be an object', line: 0 }]);
  });

  it('トップレベルがマッピングでない場合は fatal', () => {
    expect(validateYaml('- a\n').fatal).toHaveLength(1);
  });

  it('rules キーが無い場合は fatal', () => {
    expect(validateYaml('something: else\n').fatal).toEqual([
      { message: 'Policy must contain a "rules" array', line: 0 },
    ]);
  });

  it('rules がリストでない場合は fatal', () => {
    expect(validateYaml('rules: nope\n').fatal).toHaveLength(1);
  });

  it('rules の要素がマッピングでない場合は fatal（行番号付き）', () => {
    const text = ['rules:', '  - just-a-string', '  - capability: shell', '    effect: allow'].join(
      '\n',
    );

    expect(validateYaml(text).fatal).toEqual([{ message: 'Rule 0 must be an object', line: 1 }]);
  });

  it('capability が無い場合は fatal', () => {
    const text = ['rules:', '  - effect: allow'].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe('Rule 0 missing "capability"');
  });

  it('capability が文字列でない場合は fatal', () => {
    const text = ['rules:', '  - capability: 123', '    effect: allow'].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe('Rule 0 missing "capability"');
  });

  it('effect が 3 値以外の場合は fatal', () => {
    const text = ['rules:', '  - capability: shell', '    effect: permit'].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe('Invalid effect "permit" in rule 0');
  });

  it('effect が無い場合も fatal', () => {
    const text = ['rules:', '  - capability: shell'].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe('Invalid effect "(unspecified)" in rule 0');
  });

  it('match が単一文字列の場合は fatal', () => {
    const text = [
      'rules:',
      '  - capability: shell',
      '    effect: allow',
      '    match: npm test',
    ].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe('"match" must be a string array in rule 0');
  });

  it('match の要素が文字列でない場合は fatal', () => {
    const text = [
      'rules:',
      '  - capability: shell',
      '    effect: allow',
      '    match:',
      '      - 42',
    ].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe('"match" must be a string array in rule 0');
  });

  it('exclude が不正な場合も fatal', () => {
    const text = [
      'rules:',
      '  - capability: fs_write',
      '    effect: allow',
      '    exclude: .env',
    ].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe('"exclude" must be a string array in rule 0');
  });

  it('未知のキーがある場合は fatal', () => {
    const text = [
      'rules:',
      '  - capability: shell',
      '    effect: allow',
      '    mach:',
      '      - x',
    ].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe('Unknown field(s) "mach" in rule 0');
  });

  it('未知のキーが複数ある場合はまとめて出す', () => {
    const text = [
      'rules:',
      '  - capability: shell',
      '    effect: allow',
      '    mach: x',
      '    exclud: y',
    ].join('\n');

    expect(validateYaml(text).fatal[0]?.message).toBe(
      'Unknown field(s) "mach", "exclud" in rule 0',
    );
  });

  it('複数の問題をまとめて返す（本体は 1 件目で打ち切るが、修正しやすさを優先する）', () => {
    const text = [
      'rules:',
      '  - capability: shell',
      '    effect: permit',
      '  - capability: fs_read',
      '    effect: allow',
      '    match: single',
    ].join('\n');

    expect(validateYaml(text).fatal).toHaveLength(2);
  });
});

describe('スコープごとの effect 制約', () => {
  it('user と workspace はどちらも 3 値すべてを許す', () => {
    const rejected: string[] = [];

    for (const scope of ['user', 'workspace'] as const) {
      for (const effect of ['allow', 'deny', 'ask']) {
        const text = ['rules:', '  - capability: shell', `    effect: ${effect}`].join('\n');
        if (validateYaml(text, scope).fatal.length > 0) {
          rejected.push(`${scope}/${effect}`);
        }
      }
    }

    expect(rejected).toEqual([]);
  });
});

describe('パースエラーとの関係', () => {
  it('YAML が壊れている場合は fatal を足さない（parse error の表示に任せる）', () => {
    const result = parsePermissions('rules:\n  - capability: shell\n   effect: allow\n');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(validatePermissions(result, 'user').fatal).toEqual([]);
  });
});

describe('組み立てた ParseResult からも判定できる', () => {
  it('skip の位置は rules 配列の位置で返る', () => {
    const result = makeParseResult({
      rules: [
        makeRule({ index: 0 }),
        makeRule({ index: 1, capability: 'nope', capabilityRaw: 'nope' }),
        makeRule({ index: 2 }),
      ],
    });

    const validation = validatePermissions(result, 'user');

    expect([...validation.skipped.keys()]).toEqual([1]);
  });
});
