import type { ScopeContent } from './model';
import type { PermissionRule } from './parse';

/** ラベルと description の区切り。 */
const SEPARATOR = ' · ';

export interface Appearance {
  /** codicon の ID。存在確認は `@vscode/codicons` の `codicon.css` で行う（memory.md 4.2 の codicon の項） */
  icon: string;
  /** テーマカラーの ID */
  color: string;
}

/**
 * effect ごとのアイコンと色。
 *
 * 色 ID は Kiro 本体が使っている組み合わせに揃えている。形（塗りつぶし丸 + チェック /
 * 斜線入りの丸 / 吹き出しに `?`）が明確に異なるため、色を落としても 3 者を区別できる。
 */
export const EFFECT_APPEARANCE: Record<string, Appearance> = {
  allow: { icon: 'pass-filled', color: 'testing.iconPassed' },
  deny: { icon: 'circle-slash', color: 'errorForeground' },
  ask: { icon: 'ask', color: 'editorWarning.foreground' },
};

/** 未知の effect が書かれていた場合の見た目。無彩色にして異常であることを示す。 */
export const UNKNOWN_EFFECT_APPEARANCE: Appearance = {
  icon: 'question',
  color: 'descriptionForeground',
};

export function effectAppearance(effect: string): Appearance {
  return EFFECT_APPEARANCE[effect] ?? UNKNOWN_EFFECT_APPEARANCE;
}

/** match の内容を 1 行で表す。`all` / パターンそのもの / `n patterns` のいずれか。 */
export function matchSummary(rule: PermissionRule): string {
  if (rule.matchOmitted) {
    return 'all';
  }
  if (rule.matches.length === 1) {
    return rule.matches[0]!.pattern;
  }
  return `${rule.matches.length} patterns`;
}

/**
 * ルール行の description。
 *
 * `deny` / `ask` のときだけ effect を文字で併記する（`allow` は無標）。実データでは大半が
 * `allow` なので、全行に書くと本当に注意すべき `deny` が埋もれる（Q15）。
 */
export function ruleDescription(rule: PermissionRule): string {
  const parts: string[] = [];
  if (rule.effect === 'deny' || rule.effect === 'ask') {
    parts.push(rule.effect);
  }
  parts.push(matchSummary(rule));
  return parts.join(SEPARATOR);
}

/**
 * ルール行の読み上げ用ラベル。
 *
 * effect をアイコンだけで表すとスクリーンリーダーには伝わらないため、`allow` も含めて
 * 完全な情報を入れる（Q15）。
 */
export function ruleAccessibilityLabel(rule: PermissionRule): string {
  return `${rule.capability}, ${rule.effect}, ${matchSummary(rule)}`;
}

/** ルールが子ノード（パターン行）を持つか。1 件以下は description に出すので子を作らない。 */
export function hasPatternChildren(rule: PermissionRule): boolean {
  return !rule.matchOmitted && rule.matches.length > 1;
}

/**
 * スコープ行の description。
 *
 * 折りたたんだ状態でも異常（未設定・解析エラー）と規模が分かるようにする（Q15）。
 */
export function scopeDescription(content: ScopeContent): string {
  if (content.state === 'missing') {
    return 'not set';
  }
  if (content.state === 'read-error') {
    return 'read error';
  }
  if (content.result.errors.length > 0) {
    return 'parse error';
  }

  const count = content.result.rules.length;
  return count === 1 ? '1 rule' : `${count} rules`;
}

/** パースエラー 1 件の表示。行番号は 1-based に直して見せる。 */
export function formatParseError(error: { line: number; message: string }): string {
  return `Line ${error.line + 1}: ${error.message}`;
}
