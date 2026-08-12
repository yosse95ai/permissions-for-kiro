import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';

/** capability / effect が読み取れなかったときの表示。 */
export const UNKNOWN = '(unspecified)';

export interface MatchPattern {
  pattern: string;
  /** 0-based。`vscode.Position` に渡せる形で保持する */
  line: number;
}

/**
 * `match` の書き方。
 *
 * **Kiro は文字列の配列以外を fatal 扱いする**（memory.md 3.4）。`scalar`（`match: "npm test"`）も
 * 含まれる点に注意。判定は `validate.ts` が行うので、ここでは形の事実だけを記録する。
 */
export type MatchShape = 'omitted' | 'list' | 'scalar' | 'other';

/** トップレベルの形。**Kiro はマッピング以外を fatal 扱いする。** */
export type TopLevelShape = 'mapping' | 'empty' | 'other';

/** `rules` キーの状態。**`ok` 以外は Kiro では fatal。** */
export type RulesKeyState = 'ok' | 'missing' | 'not-a-list';

/** Kiro がルールに認めるキー。**これ以外が 1 つでもあると fatal**（memory.md 3.4） */
export const KNOWN_RULE_FIELDS: readonly string[] = ['capability', 'effect', 'match', 'exclude'];

/** `match` / `exclude` の読み取り結果。 */
export interface PatternList {
  /** 表示のために読めた分だけ入れる。形が不正でも空にはしない */
  patterns: MatchPattern[];
  shape: MatchShape;
  /** 要素に文字列でないものがあった。Kiro では fatal */
  hasNonStringEntry: boolean;
}

export interface PermissionRule {
  /**
   * YAML 上の `rules[]` のインデックス。
   *
   * mapping でない要素は `rules` 配列に入らないため、**配列位置とはずれることがある。**
   * Kiro の診断メッセージ（`Rule N ...`）と突き合わせるために元の位置を保持する。
   */
  index: number;
  /** 表示用の capability。読み取れなければ `UNKNOWN` */
  capability: string;
  /**
   * 文字列として書かれていた場合の生の値。それ以外は `undefined`。
   *
   * **Kiro は文字列でない `capability` を fatal 扱いする**ため、表示用の値とは別に持つ。
   */
  capabilityRaw: string | undefined;
  /** 表示用の effect。読み取れなければ `UNKNOWN` */
  effect: string;
  /** 文字列として書かれていた場合の生の値。それ以外は `undefined` */
  effectRaw: string | undefined;
  /** ルール定義の開始行。0-based */
  line: number;
  /** YAML の記載順を保った match パターン。**形が不正でも表示のために読めた分は入れる** */
  matches: MatchPattern[];
  matchShape: MatchShape;
  /** `match` の要素に文字列でないものがあった。Kiro では fatal */
  hasNonStringMatchEntry: boolean;
  /** `exclude` の読み取り結果。Kiro は `match` と同じ形式を要求する */
  exclude: PatternList;
  /** `capability` / `effect` / `match` / `exclude` 以外のキー。**Kiro では fatal** */
  unknownFields: string[];
}

export interface ParseError {
  message: string;
  /** 0-based */
  line: number;
  /** 0-based */
  column: number;
  /** `yaml` パッケージのエラーコード（例: `MISSING_CHAR`、`BAD_INDENT`） */
  code?: string;
}

export interface ParseResult {
  rules: PermissionRule[];
  /** YAML として壊れていた場合のエラー。空配列なら正常 */
  errors: ParseError[];
  topLevelShape: TopLevelShape;
  rulesKey: RulesKeyState;
  /**
   * mapping でなかった `rules[]` の要素。
   *
   * Kiro はこれを fatal（`Rule N must be an object`）として扱う。該当行へジャンプできるように
   * インデックスと行番号の両方を持つ。
   */
  nonMappingRules: Array<{ index: number; line: number }>;
}

/**
 * `linePos` は 1-based を返すため 0-based に変換する。
 *
 * `YAMLMap#get(key, true)` の戻り値が `unknown` なので、引数も `unknown` で受けて絞る。
 */
function lineOf(node: unknown, lineCounter: LineCounter): number {
  const start = isNode(node) ? node.range?.[0] : undefined;
  if (start === undefined) {
    return 0;
  }
  return Math.max(0, lineCounter.linePos(start).line - 1);
}

/**
 * 表示用に文字列化する。
 *
 * 数値や真偽値も見せる（ファイルに何が書かれているかを伝えるため）。**Kiro が受け付けるかは
 * 別の話**なので、規則としての判定には `*Raw` の側を使う。
 */
function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/** 文字列として書かれていた場合だけ値を返す。Kiro の `typeof x === 'string'` 判定に対応する。 */
function rawString(node: unknown): string | undefined {
  if (isScalar(node) && typeof node.value === 'string') {
    return node.value;
  }
  return undefined;
}

/**
 * `match` / `exclude` を読む。Kiro はどちらにも同じ形式（文字列の配列）を要求する。
 *
 * 形が不正でも**読めたパターンは表示のために残す。** 妥当性は `validate.ts` が判断する。
 */
function readPatternList(node: unknown, lineCounter: LineCounter): PatternList {
  if (node === undefined || node === null) {
    return { patterns: [], shape: 'omitted', hasNonStringEntry: false };
  }

  if (isSeq(node)) {
    const patterns: MatchPattern[] = [];
    let hasNonStringEntry = false;

    node.items.forEach((entry) => {
      const raw = rawString(entry);
      if (raw !== undefined) {
        patterns.push({ pattern: raw, line: lineOf(entry, lineCounter) });
        return;
      }
      // 文字列以外。Kiro は受け付けないが、書かれている内容は表示する。
      hasNonStringEntry = true;
      const coerced = isScalar(entry) ? scalarString(entry.value) : undefined;
      if (coerced !== undefined) {
        patterns.push({ pattern: coerced, line: lineOf(entry, lineCounter) });
      }
    });

    return { patterns, shape: 'list', hasNonStringEntry };
  }

  if (isScalar(node)) {
    // `match: "npm test"` のような単一文字列。**Kiro では fatal。**
    const pattern = scalarString(node.value);
    return {
      patterns: pattern === undefined ? [] : [{ pattern, line: lineOf(node, lineCounter) }],
      shape: 'scalar',
      hasNonStringEntry: false,
    };
  }

  return { patterns: [], shape: 'other', hasNonStringEntry: false };
}

function emptyResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    rules: [],
    errors: [],
    topLevelShape: 'empty',
    rulesKey: 'missing',
    nonMappingRules: [],
    ...overrides,
  };
}

/**
 * permissions ファイルをパースしてルールの一覧を返す。
 *
 * `permissions.json` も同じパーサで扱える（YAML は JSON のスーパーセット）。行番号を
 * 保持するため `parseDocument` + `LineCounter` を使う。
 *
 * **この関数は Kiro の規則を判定しない。** 形の事実だけを記録し、妥当性の判定は
 * `validate.ts` に任せる（memory.md 3.4 の検証仕様に対応させるため）。
 */
export function parsePermissions(text: string): ParseResult {
  const lineCounter = new LineCounter();

  let doc;
  try {
    doc = parseDocument(text, { lineCounter });
  } catch (err) {
    // parseDocument は基本的に throw せず doc.errors に積むが、想定外の例外に備える。
    return emptyResult({
      errors: [{ message: err instanceof Error ? err.message : String(err), line: 0, column: 0 }],
      topLevelShape: 'other',
    });
  }

  if (doc.errors.length > 0) {
    const errors = doc.errors.map((err) => {
      const pos = lineCounter.linePos(err.pos[0]);
      return {
        message: err.message,
        line: Math.max(0, pos.line - 1),
        column: Math.max(0, pos.col - 1),
        code: err.code,
      };
    });
    // 壊れた YAML は Kiro でも読み込めない。表示は `parse error` を優先するため
    // topLevelShape は判定不能として `other` にしておく。
    return emptyResult({ errors, topLevelShape: 'other' });
  }

  const contents = doc.contents;
  if (contents === null || contents === undefined) {
    // 空ファイル、空白のみ、コメントのみ。
    return emptyResult();
  }
  if (!isMap(contents)) {
    return emptyResult({ topLevelShape: 'other' });
  }

  const rulesNode = doc.get('rules', true);
  if (rulesNode === undefined || rulesNode === null) {
    return emptyResult({ topLevelShape: 'mapping', rulesKey: 'missing' });
  }
  if (!isSeq(rulesNode)) {
    return emptyResult({ topLevelShape: 'mapping', rulesKey: 'not-a-list' });
  }

  const rules: PermissionRule[] = [];
  const nonMappingRules: Array<{ index: number; line: number }> = [];

  rulesNode.items.forEach((item, index) => {
    if (!isMap(item)) {
      nonMappingRules.push({ index, line: lineOf(item, lineCounter) });
      return;
    }

    const capabilityNode = item.get('capability', true);
    const effectNode = item.get('effect', true);
    const match = readPatternList(item.get('match', true), lineCounter);
    const exclude = readPatternList(item.get('exclude', true), lineCounter);

    const unknownFields = item.items
      .map((pair) => (isScalar(pair.key) ? scalarString(pair.key.value) : undefined))
      .filter((key): key is string => key !== undefined && !KNOWN_RULE_FIELDS.includes(key));

    rules.push({
      index,
      capability:
        (isScalar(capabilityNode) ? scalarString(capabilityNode.value) : undefined) ?? UNKNOWN,
      capabilityRaw: rawString(capabilityNode),
      effect: (isScalar(effectNode) ? scalarString(effectNode.value) : undefined) ?? UNKNOWN,
      effectRaw: rawString(effectNode),
      line: lineOf(item, lineCounter),
      matches: match.patterns,
      matchShape: match.shape,
      hasNonStringMatchEntry: match.hasNonStringEntry,
      exclude,
      unknownFields,
    });
  });

  return {
    rules,
    errors: [],
    topLevelShape: 'mapping',
    rulesKey: 'ok',
    nonMappingRules,
  };
}
