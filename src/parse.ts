import type { Node } from 'yaml';
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';

/** capability / effect が読み取れなかったときの表示。 */
export const UNKNOWN = '(unspecified)';

export interface MatchPattern {
  pattern: string;
  /** 0-based。`vscode.Position` に渡せる形で保持する */
  line: number;
}

export interface PermissionRule {
  capability: string;
  /** `allow` / `deny` / `ask` のいずれか。未知の値もそのまま保持する */
  effect: string;
  /** ルール定義の開始行。0-based */
  line: number;
  /** YAML の記載順を保った match パターン */
  matches: MatchPattern[];
  /** `match` キー自体が書かれていない = 全対象（`all` と表示する） */
  matchOmitted: boolean;
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
  /** パースは通ったが構造が想定外だった場合のメッセージ */
  warnings: string[];
  /** YAML として壊れていた場合のエラー。空配列なら正常 */
  errors: ParseError[];
}

/** `linePos` は 1-based を返すため 0-based に変換する。 */
function lineOf(node: Node | null | undefined, lineCounter: LineCounter): number {
  const start = node?.range?.[0];
  if (start === undefined) {
    return 0;
  }
  return Math.max(0, lineCounter.linePos(start).line - 1);
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/**
 * permissions ファイルをパースしてルールの一覧を返す。
 *
 * `permissions.json` も同じパーサで扱える（YAML は JSON のスーパーセット）。行番号を
 * 保持するため `parseDocument` + `LineCounter` を使う。
 */
export function parsePermissions(text: string): ParseResult {
  const lineCounter = new LineCounter();
  const warnings: string[] = [];

  let doc;
  try {
    doc = parseDocument(text, { lineCounter });
  } catch (err) {
    // parseDocument は基本的に throw せず doc.errors に積むが、想定外の例外に備える。
    return {
      rules: [],
      warnings,
      errors: [{ message: err instanceof Error ? err.message : String(err), line: 0, column: 0 }],
    };
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
    return { rules: [], warnings, errors };
  }

  if (text.trim() === '') {
    return { rules: [], warnings, errors: [] };
  }

  const rulesNode = doc.get('rules', true);
  if (rulesNode === undefined || rulesNode === null) {
    warnings.push('No `rules` key at the top level.');
    return { rules: [], warnings, errors: [] };
  }
  if (!isSeq(rulesNode)) {
    warnings.push('`rules` is not a list.');
    return { rules: [], warnings, errors: [] };
  }

  const rules: PermissionRule[] = [];

  rulesNode.items.forEach((item, index) => {
    if (!isMap(item)) {
      warnings.push(`Skipped rules[${index}] because it is not a mapping.`);
      return;
    }

    const capabilityNode = item.get('capability', true);
    const effectNode = item.get('effect', true);
    const capability =
      (isScalar(capabilityNode) ? scalarString(capabilityNode.value) : undefined) ?? UNKNOWN;
    const effect = (isScalar(effectNode) ? scalarString(effectNode.value) : undefined) ?? UNKNOWN;

    const matches: MatchPattern[] = [];
    const matchNode = item.get('match', true);
    const matchOmitted = matchNode === undefined || matchNode === null;

    if (isSeq(matchNode)) {
      matchNode.items.forEach((entry, entryIndex) => {
        if (isScalar(entry)) {
          const pattern = scalarString(entry.value);
          if (pattern !== undefined) {
            matches.push({ pattern, line: lineOf(entry, lineCounter) });
            return;
          }
        }
        warnings.push(`Could not read rules[${index}].match[${entryIndex}] as a string.`);
      });
    } else if (isScalar(matchNode)) {
      // `match` が単一の文字列で書かれているケース。
      const pattern = scalarString(matchNode.value);
      if (pattern === undefined) {
        warnings.push(`Could not read rules[${index}].match as a string.`);
      } else {
        matches.push({ pattern, line: lineOf(matchNode, lineCounter) });
      }
    } else if (!matchOmitted) {
      warnings.push(`Unexpected shape for rules[${index}].match.`);
    }

    rules.push({
      capability,
      effect,
      line: lineOf(item, lineCounter),
      matches,
      matchOmitted,
    });
  });

  return { rules, warnings, errors: [] };
}
