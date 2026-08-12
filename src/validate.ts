import type { ParseResult, PermissionRule } from './parse';

/**
 * Kiro 本体の検証仕様を再現する層（Q33 = C）。
 *
 * **なぜ必要か。** 本体は不正なルールを黙って捨てる（non-fatal）か、設定全体を捨てて
 * fail closed にする（fatal）。拡張が書かれた内容をそのまま見せると、**実際には効いて
 * いないルールを「効いている」と表示してしまう。** この拡張の原則は「実際に効いている
 * ルールを表示する」なので、本体と同じ判定を行う。
 *
 * **リスク。** 本体の実装（`wb()` / `fr11()`）を読み取って写したものなので、Kiro の更新で
 * 条件が変わると乖離する。判定の根拠は memory.md 3.4 に表として残してある。
 */

/** Kiro が受け付ける capability。本体の Set から転記した（memory.md 3.3）。 */
export const KNOWN_CAPABILITIES: readonly string[] = [
  // メタ capability
  'all',
  'builtin',
  'filesystem',
  // 個別の capability
  'fs_read',
  'fs_write',
  'shell',
  'web_fetch',
  'web_search',
  'mcp',
  'subagent',
  'skill',
  'power',
  'context',
  'diagnostics',
  'sandbox_network',
];

/** effect として書ける値。 */
export const VALID_EFFECTS: readonly string[] = ['deny', 'allow', 'ask'];

/** この拡張が扱うスコープ。MVP は user と workspace のみ（memory.md 2.1）。 */
export type PolicyScope = 'user' | 'workspace';

/**
 * スコープごとに許される effect（memory.md 3.3 の `kc5`）。
 *
 * user と workspace はどちらも 3 値すべてを許すため、**MVP ではこの制約に引っかからない。**
 * agent / kiro スコープを扱うようになったときに効いてくるので、判定は残しておく。
 */
export const SCOPE_EFFECTS: Record<PolicyScope, readonly string[]> = {
  user: ['deny', 'ask', 'allow'],
  workspace: ['deny', 'ask', 'allow'],
};

export interface ValidationProblem {
  /**
   * 原因の説明。**英語固定**（Q31 = B）。Kiro 本体が通知に出す文言に寄せているので、
   * 検索したときに本体のメッセージと突き合わせられる。
   */
  message: string;
  /** 0-based。クリックでジャンプする先 */
  line: number;
}

export interface ScopeValidation {
  /**
   * 空でなければ**設定全体が読み込まれない**（本体が rules を破棄して fail closed になる）。
   */
  fatal: ValidationProblem[];
  /**
   * ルール単位で skip されるもの。**キーは `ParseResult.rules` 配列内の位置**（YAML 上の
   * インデックスではない）。ツリーの行と対応させるため。
   */
  skipped: Map<number, ValidationProblem>;
}

type RuleVerdict =
  | { kind: 'ok' }
  | { kind: 'skipped'; problem: ValidationProblem }
  | { kind: 'fatal'; problem: ValidationProblem };

function fatalAt(message: string, line: number): RuleVerdict {
  return { kind: 'fatal', problem: { message, line } };
}

function isBadPatternList(shape: string, hasNonStringEntry: boolean): boolean {
  // 省略と「文字列の配列」だけが正当。単一文字列（scalar）も本体では fatal。
  return shape === 'scalar' || shape === 'other' || hasNonStringEntry;
}

/**
 * ルール 1 件を検証する。本体の `wb()` と**同じ順序**で判定する。
 *
 * 順序が意味を持つ点が 1 つある。**未知の capability は skip でそこで打ち切られる**ため、
 * そのルールの effect や match が壊れていても fatal にはならない。
 */
function validateRule(rule: PermissionRule, scope: PolicyScope): RuleVerdict {
  const at = rule.line;

  if (rule.capabilityRaw === undefined) {
    return fatalAt(`Rule ${rule.index} missing "capability"`, at);
  }

  if (!KNOWN_CAPABILITIES.includes(rule.capabilityRaw)) {
    return {
      kind: 'skipped',
      problem: {
        message: `Skipping rule ${rule.index}: unknown capability "${rule.capabilityRaw}"`,
        line: at,
      },
    };
  }

  if (rule.effectRaw === undefined || !VALID_EFFECTS.includes(rule.effectRaw)) {
    return fatalAt(`Invalid effect "${rule.effect}" in rule ${rule.index}`, at);
  }

  if (!SCOPE_EFFECTS[scope].includes(rule.effectRaw)) {
    return fatalAt(
      `${scope} scope cannot contain "${rule.effectRaw}" rules (rule ${rule.index})`,
      at,
    );
  }

  if (isBadPatternList(rule.matchShape, rule.hasNonStringMatchEntry)) {
    return fatalAt(`"match" must be a string array in rule ${rule.index}`, at);
  }

  if (isBadPatternList(rule.exclude.shape, rule.exclude.hasNonStringEntry)) {
    return fatalAt(`"exclude" must be a string array in rule ${rule.index}`, at);
  }

  if (rule.unknownFields.length > 0) {
    return fatalAt(
      `Unknown field(s) "${rule.unknownFields.join('", "')}" in rule ${rule.index}`,
      at,
    );
  }

  return { kind: 'ok' };
}

/**
 * スコープ 1 つ分の permissions を検証する。
 *
 * 本体は最初の fatal で throw して打ち切るが、**この関数は全件を集める。** 修正すべき箇所を
 * まとめて示したいため。fatal が 1 件でもあれば、そのスコープのルールはすべて効いていない。
 */
export function validatePermissions(result: ParseResult, scope: PolicyScope): ScopeValidation {
  const fatal: ValidationProblem[] = [];
  const skipped = new Map<number, ValidationProblem>();

  if (result.errors.length > 0) {
    // YAML として壊れている場合。本体でも読み込めないが、表示は `parse error` の方が
    // 具体的なので、そちらに任せてここでは何も足さない（呼び出し側で分岐する）。
    return { fatal, skipped };
  }

  if (result.topLevelShape !== 'mapping') {
    // **空ファイルもここに入る。** 本体は `yaml.parse('')` の結果 `null` を
    // 「object でない」として落とすため、空の permissions.yaml は fail closed になる。
    fatal.push({ message: 'Policy must be an object', line: 0 });
    return { fatal, skipped };
  }

  if (result.rulesKey !== 'ok') {
    fatal.push({ message: 'Policy must contain a "rules" array', line: 0 });
    return { fatal, skipped };
  }

  for (const entry of result.nonMappingRules) {
    fatal.push({ message: `Rule ${entry.index} must be an object`, line: entry.line });
  }

  result.rules.forEach((rule, position) => {
    const verdict = validateRule(rule, scope);
    if (verdict.kind === 'fatal') {
      fatal.push(verdict.problem);
    } else if (verdict.kind === 'skipped') {
      skipped.set(position, verdict.problem);
    }
  });

  return { fatal, skipped };
}
