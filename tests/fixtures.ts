import type { ParseResult, PatternList, PermissionRule } from '../src/parse';
import { type ScopeValidation, validatePermissions } from '../src/validate';

/**
 * テスト用のフィクスチャ。
 *
 * `PermissionRule` と `ParseResult` は Kiro の検証仕様を判定するためのフィールドを多く持つ
 * ので、既定値をここに集約して各テストでは関心のあるフィールドだけ上書きする。
 */

export function emptyPatternList(): PatternList {
  return { patterns: [], shape: 'omitted', hasNonStringEntry: false };
}

/** 既定は「`shell` を全対象で許可する」正当なルール。 */
export function makeRule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    index: 0,
    capability: 'shell',
    capabilityRaw: 'shell',
    effect: 'allow',
    effectRaw: 'allow',
    line: 0,
    matches: [],
    matchShape: 'omitted',
    hasNonStringMatchEntry: false,
    exclude: emptyPatternList(),
    unknownFields: [],
    ...overrides,
  };
}

/** 既定は「正しく読めた空のルール一覧」。 */
export function makeParseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    rules: [],
    errors: [],
    topLevelShape: 'mapping',
    rulesKey: 'ok',
    nonMappingRules: [],
    ...overrides,
  };
}

/** 問題のない検証結果。 */
export function okValidation(): ScopeValidation {
  return { fatal: [], skipped: new Map() };
}

/**
 * `ParseResult` から実際の検証を通した結果を作る。
 *
 * 手で `ScopeValidation` を組むより、**判定ロジックと表示が食い違わない**のでこちらを使う。
 */
export function validationOf(result: ParseResult): ScopeValidation {
  return validatePermissions(result, 'user');
}
