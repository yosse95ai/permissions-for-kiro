import * as vscode from 'vscode';

import type { ScopeContent } from './model';
import type { PermissionRule } from './parse';
import type { ScopeValidation } from './validate';

/** ラベルと description の区切り。 */
const SEPARATOR = ' · ';

export interface Appearance {
  /** codicon の ID。存在確認は `@vscode/codicons` の `codicon.css` で行う（存在しない ID を渡しても例外にならず、アイコンが空白になるだけのため） */
  icon: string;
  /** テーマカラーの ID。**省略すると既定色**（無彩色）になる */
  color?: string;
}

/**
 * ルールが実際に効いているか。
 *
 * | 値 | 意味 |
 * | - | - |
 * | `active` | 効いている |
 * | `skipped` | このルールだけ Kiro に捨てられている（未知の capability） |
 * | `inactive` | スコープ全体が読み込まれていないため効いていない |
 */
export type RuleState = 'active' | 'skipped' | 'inactive';

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

/**
 * `match` のパターン行の見た目。
 *
 * 色は **`charts.green`**。`allow` の緑（`testing.iconPassed`）とは別の ID を使う。
 * `deny` ルールの `match` 行も緑になるため、effect の緑と同じ色にすると「許可」の意味に
 * 読めてしまう。ここでの緑は「対象に含まれる範囲」を表す。
 */
export const MATCH_APPEARANCE: Appearance = { icon: 'gear', color: 'charts.green' };

/**
 * `exclude` のパターン行の見た目。
 *
 * **灰色にする。** 赤は `deny` と `not loaded` で既に使っていて意味を増やしたくない。
 * `match` 行が既定色なので、**色の濃淡と形の両方**で区別できる。
 */
export const EXCLUDE_APPEARANCE: Appearance = {
  icon: 'exclude',
  color: 'descriptionForeground',
};

/** Kiro に捨てられているルールの見た目。**effect アイコンを置き換える。** */
export const SKIPPED_APPEARANCE: Appearance = {
  icon: 'warning',
  color: 'editorWarning.foreground',
};

/**
 * スコープ全体が読み込まれていないときのルールの見た目。
 *
 * **色を付けない。** 緑の `pass-filled` が並んだままだと「許可されている」と誤読されるため、
 * 無彩色の輪郭だけにして効いていないことを示す。
 */
export const INACTIVE_APPEARANCE: Appearance = { icon: 'circle-outline' };

export function effectAppearance(effect: string): Appearance {
  return EFFECT_APPEARANCE[effect] ?? UNKNOWN_EFFECT_APPEARANCE;
}

/** ルール行のアイコン。効いていないルールは effect ではなく状態を表す。 */
export function ruleAppearance(rule: PermissionRule, state: RuleState): Appearance {
  if (state === 'skipped') {
    return SKIPPED_APPEARANCE;
  }
  if (state === 'inactive') {
    return INACTIVE_APPEARANCE;
  }
  return effectAppearance(rule.effect);
}

/**
 * match の内容を 1 行で表す。`all` か件数。
 *
 * **1 件でもパターン文字列を出さず件数にする。** パターンは必ず子ノードに出るので（`hasPatternChildren`
 * が 1 件でも true を返す）、description に出すと同じ文字列が 2 行に重複する。
 */
export function matchSummary(rule: PermissionRule): string {
  if (rule.matchShape === 'omitted') {
    return vscode.l10n.t('all');
  }
  const count = rule.matches.length;
  return count === 1 ? vscode.l10n.t('1 pattern') : vscode.l10n.t('{0} patterns', count);
}

/**
 * `exclude` の件数表示。無ければ `undefined`。
 *
 * **件数だけを出す。** 中身は子ノードで見せる（`hasPatternChildren` が `exclude` を持つ
 * ルールで必ず true を返すので、必ず展開できる）。
 */
export function exclusionSummary(rule: PermissionRule): string | undefined {
  const count = rule.exclude.patterns.length;
  if (count === 0) {
    return undefined;
  }
  return count === 1 ? vscode.l10n.t('1 exclusion') : vscode.l10n.t('{0} exclusions', count);
}

/**
 * ルール行の description。
 *
 * `deny` / `ask` のときだけ effect を文字で併記する（`allow` は無標）。実データでは大半が
 * `allow` なので、全行に書くと本当に注意すべき `deny` が埋もれる。
 */
export function ruleDescription(rule: PermissionRule, state: RuleState = 'active'): string {
  const parts: string[] = [];
  // 効いていないことを先頭に出す。アイコンだけだと見落とすため。
  if (state === 'skipped') {
    parts.push(vscode.l10n.t('skipped'));
  }
  if (rule.effect === 'deny' || rule.effect === 'ask') {
    parts.push(rule.effect);
  }
  parts.push(matchSummary(rule));

  // `all · 1 exclusion` のように、除外の存在を折りたたんだ状態でも示す。
  // 特に `match` 省略（= 全対象）と併用されたとき、`all` だけでは誤読を招く。
  const exclusions = exclusionSummary(rule);
  if (exclusions !== undefined) {
    parts.push(exclusions);
  }

  return parts.join(SEPARATOR);
}

/**
 * ルール行の読み上げ用ラベル。
 *
 * effect をアイコンだけで表すとスクリーンリーダーには伝わらないため、`allow` も含めて
 * 完全な情報を入れる。
 */
export function ruleAccessibilityLabel(rule: PermissionRule, state: RuleState = 'active'): string {
  const parts = [rule.capability, rule.effect, matchSummary(rule)];

  const exclusions = exclusionSummary(rule);
  if (exclusions !== undefined) {
    parts.push(exclusions);
  }

  // 効いていないルールは、アイコンの置き換えだけでは読み上げに乗らないので文字で足す。
  if (state === 'skipped') {
    parts.push(vscode.l10n.t('skipped'));
  } else if (state === 'inactive') {
    parts.push(vscode.l10n.t('not loaded'));
  }
  return parts.join(', ');
}

/**
 * ルールが子ノード（パターン行）を持つか。
 *
 * **パターンが 1 件でも子を作る**。件数によって「description に出す」「子に出す」が
 * 切り替わると、同じ種類の情報の置き場所が揺れて読みづらい。ツリー形式に統一する。
 *
 * 子を持たないのは `match` 省略かつ `exclude` 無し（= 全対象）の場合だけ。
 */
export function hasPatternChildren(rule: PermissionRule): boolean {
  return rule.matches.length + rule.exclude.patterns.length > 0;
}

/**
 * スコープ行の description。
 *
 * 折りたたんだ状態でも異常（未設定・解析エラー・**読み込まれていない**）と規模が分かる
 * ようにする。
 *
 * 優先順位は「より具体的な情報を優先する」。`parse error` は fatal の一種だが、原因が
 * はっきりしているので `not loaded` より前に出す。
 */
export function scopeDescription(content: ScopeContent, validation: ScopeValidation): string {
  if (content.state === 'missing') {
    return vscode.l10n.t('not set');
  }
  if (content.state === 'read-error') {
    return vscode.l10n.t('read error');
  }
  if (content.result.errors.length > 0) {
    return vscode.l10n.t('parse error');
  }
  if (validation.fatal.length > 0) {
    return vscode.l10n.t('not loaded');
  }

  const count = content.result.rules.length;
  // 単数形と複数形で別のキーにする。日本語のように単複同形の言語では同じ訳になる。
  const rules = count === 1 ? vscode.l10n.t('1 rule') : vscode.l10n.t('{0} rules', count);

  if (validation.skipped.size === 0) {
    return rules;
  }
  // 折りたたんでいても skip の存在に気付けるようにする。
  return `${rules}${SEPARATOR}${vscode.l10n.t('{0} skipped', validation.skipped.size)}`;
}

/** スコープ全体が読み込まれていないか。ルールの見た目を落とす判断に使う。 */
export function isScopeInactive(content: ScopeContent, validation: ScopeValidation): boolean {
  if (content.state !== 'parsed') {
    return false;
  }
  return content.result.errors.length > 0 || validation.fatal.length > 0;
}

/** ルール 1 件の状態を決める。 */
export function ruleStateOf(
  position: number,
  validation: ScopeValidation,
  scopeInactive: boolean,
): RuleState {
  if (scopeInactive) {
    return 'inactive';
  }
  return validation.skipped.has(position) ? 'skipped' : 'active';
}

/**
 * `yaml` パッケージのメッセージ末尾に付く位置情報。
 *
 * ```
 * Sequence item without - indicator at line 3, column 1:
 * ```
 *
 * `formatParseError` は先頭に `Line N:` を付けるため、この末尾は重複する。
 */
const POSITION_SUFFIX = / at line \d+, column \d+:?$/;

/**
 * パースエラー 1 件のラベル。行番号は 1-based に直して見せる。
 *
 * **1 行目だけを使い、末尾の位置情報を落とす**。`yaml` パッケージの `message` は
 * 説明文 + 該当箇所のスニペット + キャレットの**複数行**で、`TreeItem.label` は最初の改行
 * までしか表示しない。さらに `Line N:` と ` at line N, column M:` が
 * 重複するぶん、既定のサイドバー幅では説明が切り詰められて読めなくなる。
 *
 * **語句自体には手を入れない。** 全文は tooltip に出す（`tree.ts` の `messageTreeItem`）ので、
 * Kiro 本体の通知やパーサのドキュメントと突き合わせる用途はそちらが担う。
 *
 * **翻訳しない。** `message` は `yaml` パッケージが返す英語固定の文字列で訳す手段がなく、
 * 枠だけ訳すと 1 行の中で言語が混ざる。
 */
export function formatParseError(error: { line: number; message: string }): string {
  const [firstLine = ''] = error.message.split('\n');
  return `Line ${error.line + 1}: ${firstLine.replace(POSITION_SUFFIX, '')}`;
}
