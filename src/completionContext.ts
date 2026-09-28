// `jsonc-parser` の既定の入口（`main`）は UMD で、中の相対 `require` がバンドルに取り込まれず
// 実行時に落ちる。ESM 版を直接読む。
import {
  findNodeAtLocation,
  getLocation,
  type Node as JsonNode,
  parseTree,
} from 'jsonc-parser/lib/esm/main.js';

import type { PermissionsFormat } from './permissionsFile';

/**
 * 補完のために、カーソルが permissions ファイルのどこにあるかを判定する層。
 *
 * **vscode に依存しない。** 行の配列とカーソル位置だけを受け取るので、エディタを
 * モックせずにテストできる（CONTRIBUTING.md の「vscode に依存しない層を太らせる」）。
 *
 * 何を候補に出すかは形式（YAML / JSON）によらないので、どちらの判定も同じ
 * `CompletionRequest` を返す。候補そのものは `completionCandidates.ts` が作る。
 */

/** 0-based のカーソル位置。`vscode.Position` と同じ形。 */
export interface CursorPosition {
  line: number;
  character: number;
}

/** カーソルがどこにあるか。出す候補の種類はこれだけで決まる。 */
export type CompletionSite =
  | {
      /** トップレベルのキー（`rules`） */
      kind: 'top-level-key';
      /** すでに書かれているトップレベルのキー（カーソルの行は除く） */
      present: readonly string[];
      /** カーソルの後ろに `:` がある（キーの名前だけを直している） */
      colonAfter: boolean;
    }
  | {
      /** ルールのキー（`capability` / `effect` / `match` / `exclude`） */
      kind: 'rule-key';
      /** 同じルールにすでに書かれているキー（カーソルの行は除く） */
      present: readonly string[];
      colonAfter: boolean;
    }
  | { kind: 'capability-value' }
  | { kind: 'effect-value' }
  | {
      /** `match` / `exclude` の要素 */
      kind: 'pattern';
      list: 'match' | 'exclude';
      /** 同じルールの `capability` の値。カーソルより後ろに書かれていても拾う */
      capability: string | undefined;
    };

export interface CompletionRequest {
  site: CompletionSite;
  /** 置き換える範囲。カーソルと同じ行の、開始列と終了列（0-based、終了は含まない） */
  replace: { start: number; end: number };
}

/** キーとして補完の対象にする文字。capability 名などと同じく英数字と `_` だけ。 */
const KEY_CHAR = /^[A-Za-z0-9_]$/;

/** カーソルより前に書かれたキーが、補完の対象になる形か（空も可）。 */
const TYPED_KEY = /^[A-Za-z_][A-Za-z0-9_]*$|^$/;

/** 書かれているキーを読み取る。引用符で囲んだキー（`"capability":`）も受ける。 */
const WRITTEN_KEY = /^(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\s*:(?:\s|$)/;

/** `rules:` の行。値を同じ行に書いたもの（`rules: []` など）はブロックスタイルではない。 */
const RULES_LINE = /^rules:\s*(?:#.*)?$/;

/** ブロックスタイルのシーケンスの要素（`- ` か、`-` だけの行）。 */
const DASH_LINE = /^(\s*)-(?:\s|$)/;

/** 値がこれで始まるときはフロースタイルかブロックスカラーなので、候補を出さない。 */
const NON_PLAIN_VALUE_START = /^[[{|>]/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

interface LineScan {
  /** コメントの `#` の位置。なければ -1 */
  comment: number;
  /** `from` 以降で最初の、マッピングの `:`（直後が空白か行末）の位置。なければ -1 */
  colon: number;
}

/**
 * 1 行を読み、コメントの開始位置とマッピングの `:` の位置を返す。
 *
 * 引用符は**スカラーの先頭にあるときだけ**引用符として扱う。プレーンスカラーの途中の
 * 引用符（`git commit -m "fix # 1"` の `"`）は文字そのもので、その中の ` #` は YAML では
 * コメントになる。
 */
function scanLine(line: string, from: number = 0): LineScan {
  let quote: '"' | "'" | undefined;
  let atScalarStart = true;
  let colon = -1;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (quote !== undefined) {
      if (quote === '"' && ch === '\\') {
        i++; // エスケープされた次の文字を読み飛ばす
      } else if (ch === quote) {
        if (quote === "'" && line[i + 1] === "'") {
          i++; // 単一引用符の中の `''` は `'` 1 文字
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      continue;
    }

    const next = line[i + 1];
    const followedBySpace = next === undefined || next === ' ' || next === '\t';

    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return { comment: i, colon };
    }

    if (atScalarStart && (ch === '"' || ch === "'")) {
      quote = ch;
      atScalarStart = false;
      continue;
    }

    // シーケンスの `- ` は、スカラーの先頭にあるときだけ指示子になる（`echo a - b` の
    // `-` は文字そのもの）。その後ろも新しいスカラーの先頭。
    if (ch === '-' && followedBySpace && atScalarStart) {
      continue;
    }

    // マッピングの `: ` の後ろは新しいスカラーの先頭になる。
    if (ch === ':' && followedBySpace) {
      if (colon === -1 && i >= from) {
        colon = i;
      }
      atScalarStart = true;
      continue;
    }

    atScalarStart = false;
  }

  return { comment: -1, colon };
}

/** 引用符と後ろのコメントを取り除いた値。 */
function plainValue(line: string, colon: number): string {
  const { comment } = scanLine(line);
  const raw = line.slice(colon + 1, comment === -1 ? undefined : comment).trim();
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  return quoted === null ? raw : quoted[2]!;
}

/** `column` から書かれているキーの名前。キーでなければ `undefined`。 */
function writtenKey(line: string, column: number): string | undefined {
  return WRITTEN_KEY.exec(line.slice(column))?.[2];
}

/**
 * キーの位置での置換範囲。キーの先頭から、カーソルの後ろに続く単語の終わりまで。
 */
function keyRange(line: string, keyStart: number): CompletionRequest['replace'] {
  let end = keyStart;
  while (end < line.length && KEY_CHAR.test(line[end]!)) {
    end++;
  }
  return { start: keyStart, end };
}

/**
 * 値やパターンの位置での置換範囲。値の先頭（開き引用符を含む）から行末まで。
 *
 * 行末のコメント（空白 + `#`）は残す。
 */
function valueRange(line: string, valueFrom: number, cursor: number): CompletionRequest['replace'] {
  const { comment } = scanLine(line);
  let end = comment === -1 ? line.length : comment;
  while (end > valueFrom && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    end--;
  }

  let start = valueFrom;
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) {
    start++;
  }

  return { start: Math.min(start, cursor), end: Math.max(end, cursor) };
}

/** キーの位置で、カーソルより前に書かれたものが補完の対象になる形か。 */
function isTypedKey(line: string, keyStart: number, cursor: number): boolean {
  return TYPED_KEY.test(line.slice(keyStart, cursor));
}

/** YAML のルール 1 件の範囲。 */
interface RuleBlock {
  /** `-` のある行 */
  start: number;
  /** 範囲の終わり（含まない） */
  end: number;
  /** キーが始まる列 */
  keyCol: number;
}

/**
 * `key: value` の形の行で、カーソルがキーと値のどちらにあるかを判定する。
 *
 * @param keyStart キーが始まる列
 * @param keySite キーの位置だったときの `CompletionSite` を作る
 * @param valueSite 値の位置だったときの `CompletionSite` を作る（キーの名前を受け取る）
 */
function keyOrValue(
  line: string,
  keyStart: number,
  cursor: number,
  keySite: (colonAfter: boolean) => CompletionSite,
  valueSite: (key: string) => CompletionSite | undefined,
): CompletionRequest | undefined {
  const { colon } = scanLine(line, keyStart);

  if (colon === -1 || cursor <= colon) {
    if (!isTypedKey(line, keyStart, cursor)) {
      return undefined;
    }
    return { site: keySite(colon !== -1), replace: keyRange(line, keyStart) };
  }

  const key = writtenKey(line, keyStart);
  const site = key === undefined ? undefined : valueSite(key);
  if (site === undefined) {
    return undefined;
  }

  if (NON_PLAIN_VALUE_START.test(line.slice(colon + 1).trimStart())) {
    return undefined;
  }
  return { site, replace: valueRange(line, colon + 1, cursor) };
}

/** ルールの中の、キーの列にあるキーを集める（`except` の行は除く）。 */
function keysOfRule(lines: readonly string[], rule: RuleBlock, except: number): string[] {
  const keys: string[] = [];
  for (let i = rule.start; i < rule.end; i++) {
    if (i === except) {
      continue;
    }
    const line = lines[i]!;
    const isKeyLine = i === rule.start || (indentOf(line) === rule.keyCol && !DASH_LINE.test(line));
    const key = isKeyLine ? writtenKey(line, rule.keyCol) : undefined;
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys;
}

/** ルールの `capability` の値。カーソルより後ろの行も見る（`match:` を先に書いた場合）。 */
function capabilityOfRule(lines: readonly string[], rule: RuleBlock): string | undefined {
  for (let i = rule.start; i < rule.end; i++) {
    const line = lines[i]!;
    const isKeyLine = i === rule.start || (indentOf(line) === rule.keyCol && !DASH_LINE.test(line));
    if (!isKeyLine || writtenKey(line, rule.keyCol) !== 'capability') {
      continue;
    }
    const value = plainValue(line, scanLine(line, rule.keyCol).colon);
    return value === '' ? undefined : value;
  }
  return undefined;
}

/**
 * `match:` / `exclude:` の要素の位置か。そうなら、どちらのリストかを返す。
 *
 * 上にたどって、キーの列にある最も近いキーを見る。`match:` と同じ列に `-` を書く
 * 書き方も YAML では正しいので、要素の `-` がキーの列ちょうどの場合も受ける。
 */
function listOfPattern(
  lines: readonly string[],
  rule: RuleBlock,
  lineIndex: number,
): 'match' | 'exclude' | undefined {
  // 見つからなければ、ルールの開始行（`- key: ...`）のキーが最も近い。
  let keyLine = rule.start;
  for (let i = lineIndex - 1; i > rule.start; i--) {
    const line = lines[i]!;
    if (
      !isBlank(line) &&
      !line.trimStart().startsWith('#') &&
      indentOf(line) === rule.keyCol &&
      !DASH_LINE.test(line)
    ) {
      keyLine = i;
      break;
    }
  }

  const line = lines[keyLine]!;
  const key = writtenKey(line, rule.keyCol);
  if (key !== 'match' && key !== 'exclude') {
    return undefined;
  }
  // `match: ["git *"]` のように同じ行に値があるものはフロースタイルなので、対象にしない。
  const value = plainValue(line, scanLine(line, rule.keyCol).colon);
  return value === '' ? key : undefined;
}

/** ルールの開始行から、キーが始まる列を決める。 */
function keyColumnOf(lines: readonly string[], start: number, end: number): number {
  const line = lines[start]!;
  const dash = indentOf(line);
  const afterDash = line.slice(dash + 1);
  const spaces = afterDash.length - afterDash.trimStart().length;

  if (afterDash.trim() !== '' && !afterDash.trimStart().startsWith('#')) {
    return dash + 1 + spaces;
  }

  // `-` だけの行。キーは次の行から始まる。
  for (let i = start + 1; i < end; i++) {
    const next = lines[i]!;
    if (!isBlank(next) && !next.trimStart().startsWith('#')) {
      return indentOf(next);
    }
  }
  return dash + 2;
}

/**
 * YAML の permissions ファイルで、カーソル位置の文脈を判定する。
 *
 * AST ではなく行テキストとインデントで判定する。書きかけのバッファ（`r` 1 文字など）では
 * `parseDocument` が役に立たないため。ブロックスタイルだけを対象にし、フロースタイルの
 * 中では `undefined` を返す。
 *
 * @returns 候補を出す位置でなければ `undefined`
 */
export function yamlCompletionRequest(
  input: readonly string[],
  position: CursorPosition,
): CompletionRequest | undefined {
  // `document.lineAt().text` は改行を含まないが、分割しただけの CRLF の文字列にも備える。
  const lines = input.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const lineIndex = position.line;
  const cursor = position.character;
  const line = lines[lineIndex];
  if (line === undefined) {
    return undefined;
  }

  // コメントの中と、`:` の直後（空白を打つ前）では出さない。
  const { comment } = scanLine(line);
  if (comment !== -1 && comment < cursor) {
    return undefined;
  }
  if (cursor > 0 && line[cursor - 1] === ':') {
    return undefined;
  }

  // `rules:` の行と、ルールの並びが続く範囲。
  const rulesLine = lines.findIndex((candidate) => RULES_LINE.test(candidate));
  let rulesEnd = lines.length;
  if (rulesLine !== -1) {
    for (let i = rulesLine + 1; i < lines.length; i++) {
      const candidate = lines[i]!;
      if (
        !isBlank(candidate) &&
        indentOf(candidate) === 0 &&
        !candidate.startsWith('#') &&
        !DASH_LINE.test(candidate)
      ) {
        rulesEnd = i;
        break;
      }
    }
  }

  if (rulesLine === -1 || lineIndex <= rulesLine || lineIndex >= rulesEnd) {
    return topLevelRequest(lines, lineIndex, cursor);
  }

  // ルールの列。`rules:` の下で最初に出てくる `-` の列を基準にする（`match:` の下の `-` と
  // 取り違えないため）。
  let ruleDashCol = -1;
  for (let i = rulesLine + 1; i < rulesEnd; i++) {
    const match = DASH_LINE.exec(lines[i]!);
    if (match !== null) {
      ruleDashCol = match[1]!.length;
      break;
    }
  }
  if (ruleDashCol === -1) {
    return undefined;
  }

  // 今いるルール。ルールの列ちょうどに `-` がある行が開始行。
  const starts: number[] = [];
  for (let i = rulesLine + 1; i < rulesEnd; i++) {
    const match = DASH_LINE.exec(lines[i]!);
    if (match !== null && match[1]!.length === ruleDashCol) {
      starts.push(i);
    }
  }
  // `findLastIndex` は ES2023 で、tsconfig の lib（ES2022）にはない。
  let startIndex = -1;
  for (let i = 0; i < starts.length && starts[i]! <= lineIndex; i++) {
    startIndex = i;
  }
  if (startIndex === -1) {
    return undefined;
  }
  const start = starts[startIndex]!;
  const end = starts[startIndex + 1] ?? rulesEnd;
  const rule: RuleBlock = { start, end, keyCol: keyColumnOf(lines, start, end) };

  // ルールの中での位置。
  return ruleRequest(lines, rule, lineIndex, cursor);
}

/** ルールのキーの値の位置。候補があるのは `capability` と `effect` だけ。 */
function ruleValueSite(key: string): CompletionSite | undefined {
  if (key === 'capability') {
    return { kind: 'capability-value' };
  }
  if (key === 'effect') {
    return { kind: 'effect-value' };
  }
  return undefined;
}

function ruleRequest(
  lines: readonly string[],
  rule: RuleBlock,
  lineIndex: number,
  cursor: number,
): CompletionRequest | undefined {
  const line = lines[lineIndex]!;
  const keySite = (colonAfter: boolean): CompletionSite => ({
    kind: 'rule-key',
    present: keysOfRule(lines, rule, lineIndex),
    colonAfter,
  });
  // 空白だけの行: カーソルの列をインデントとみなす。キーの列なら新しいキーを書く位置。
  if (isBlank(line)) {
    if (cursor !== rule.keyCol) {
      return undefined;
    }
    return { site: keySite(false), replace: { start: cursor, end: cursor } };
  }

  // ルールの開始行（`- capability: ...`）。
  if (lineIndex === rule.start) {
    if (cursor < rule.keyCol) {
      return undefined; // `-` の直後（空白の前）など
    }
    return keyOrValue(line, rule.keyCol, cursor, keySite, ruleValueSite);
  }

  const dash = DASH_LINE.exec(line);

  // キーの列から始まる、`-` ではない行。
  if (dash === null) {
    if (indentOf(line) !== rule.keyCol) {
      return undefined;
    }
    return keyOrValue(line, rule.keyCol, cursor, keySite, ruleValueSite);
  }

  // `-` で始まる行で、`-` がキーの列以上: `match:` / `exclude:` の要素。
  const dashCol = dash[1]!.length;
  if (dashCol < rule.keyCol || cursor < dashCol + 2) {
    return undefined;
  }
  const list = listOfPattern(lines, rule, lineIndex);
  if (list === undefined) {
    return undefined;
  }

  if (NON_PLAIN_VALUE_START.test(line.slice(dashCol + 1).trimStart())) {
    return undefined;
  }
  return {
    site: { kind: 'pattern', list, capability: capabilityOfRule(lines, rule) },
    replace: valueRange(line, dashCol + 1, cursor),
  };
}

/** `rules:` の外。インデント 0 のキーだけを扱う。 */
function topLevelRequest(
  lines: readonly string[],
  lineIndex: number,
  cursor: number,
): CompletionRequest | undefined {
  const line = lines[lineIndex]!;

  const present = lines
    .filter((_, i) => i !== lineIndex)
    .filter((candidate) => indentOf(candidate) === 0)
    .map((candidate) => writtenKey(candidate, 0))
    .filter((key): key is string => key !== undefined);

  if (isBlank(line)) {
    if (cursor !== 0) {
      return undefined;
    }
    return {
      site: { kind: 'top-level-key', present, colonAfter: false },
      replace: { start: 0, end: 0 },
    };
  }

  if (indentOf(line) !== 0 || DASH_LINE.test(line)) {
    return undefined;
  }

  return keyOrValue(
    line,
    0,
    cursor,
    (colonAfter) => ({ kind: 'top-level-key', present, colonAfter }),
    // トップレベルの値（`rules:` の右側）には候補がない。
    () => undefined,
  );
}

/** 値が始まる直前に来る記号。これ以外の文字の直後は、書きかけのリテラル（`tr` など）の中。 */
const JSON_VALUE_OPENERS = new Set(['{', '[', ',', ':']);

/** 閉じ引用符まで書かれた文字列か（最後の `"` がエスケープされていない）。 */
function isTerminatedString(text: string, node: JsonNode): boolean {
  const end = node.offset + node.length;
  if (node.length < 2 || text[end - 1] !== '"') {
    return false;
  }
  let backslashes = 0;
  for (let i = end - 2; i > node.offset && text[i] === '\\'; i--) {
    backslashes++;
  }
  return backslashes % 2 === 0;
}

/**
 * `rules` の要素の中の、長さ `length` のパスか（`['rules', 0, ...]`）。
 *
 * `Location.matches()` は前方一致で、`['rules', '*', 'capability']` が
 * `['rules', 0, 'capability', 'x']` にも一致してしまうため、長さも比べる。
 */
function isRulePath(path: readonly (string | number)[], length: number): boolean {
  return path.length === length && path[0] === 'rules' && typeof path[1] === 'number';
}

/**
 * `parseTree()` の結果から `path` のノードを取る。
 *
 * `parseTree()` が `undefined` を返すのは中身のない文字列だけで、キーや値の位置に
 * カーソルがあるなら木はあるはず。型のための防御。
 */
function nodeAt(root: JsonNode | undefined, path: (string | number)[]): JsonNode | undefined {
  return root === undefined ? undefined : findNodeAtLocation(root, path);
}

/** オブジェクトのキーを集める。`skipKeyAt` の位置のキー（書いている途中のもの）は除く。 */
function keysOfObject(node: JsonNode | undefined, skipKeyAt: number | undefined): string[] {
  if (node?.type !== 'object') {
    return [];
  }
  const keys: string[] = [];
  for (const property of node.children ?? []) {
    const key = property.children?.[0];
    if (key?.type === 'string' && key.offset !== skipKeyAt && typeof key.value === 'string') {
      keys.push(key.value);
    }
  }
  return keys;
}

/**
 * JSON の permissions ファイルで、カーソル位置の文脈を判定する。
 *
 * JSON は 1 行に複数のキーを並べられるので、YAML と同じ行単位の判定は使えない。
 * `jsonc-parser` の `getLocation()` は書きかけの JSON でも位置を返す（本体の
 * `configuration-editing` / `npm` 拡張と同じ方法）。
 *
 * @returns 候補を出す位置でなければ `undefined`
 */
export function jsonCompletionRequest(
  input: readonly string[],
  position: CursorPosition,
): CompletionRequest | undefined {
  const lines = input.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const line = lines[position.line];
  if (line === undefined) {
    return undefined;
  }

  // `\n` でつなぐ。`lineAt().text` は改行を含まないので、CRLF のファイルでも位置がずれない。
  const text = lines.join('\n');
  const lineStart = lines.slice(0, position.line).reduce((sum, l) => sum + l.length + 1, 0);
  const offset = lineStart + position.character;

  const location = getLocation(text, offset);
  const previous = location.previousNode;

  // カーソルを含む文字列（キーか値）。なければ、値やキーを書き始める位置か確かめる。
  let replace: CompletionRequest['replace'];
  let colonAfter = false;
  if (previous !== undefined) {
    const isString = previous.type === 'string' || previous.type === 'property';
    const end = previous.offset + previous.length;
    const inside =
      previous.offset < offset &&
      (offset < end || (offset === end && !isTerminatedString(text, previous)));
    if (!isString || !inside) {
      return undefined;
    }
    // JSON の文字列は改行を含まないので、同じ行に収まる。
    replace = { start: previous.offset - lineStart, end: end - lineStart };
    if (isTerminatedString(text, previous)) {
      colonAfter = /^\s*:/.test(text.slice(end));
    }
  } else {
    const before = text.slice(0, offset).trimEnd();
    if (!JSON_VALUE_OPENERS.has(before[before.length - 1] ?? '')) {
      return undefined;
    }
    replace = { start: position.character, end: position.character };
  }

  const { path, isAtPropertyKey } = location;
  const root = parseTree(text);
  const editingKeyAt = isAtPropertyKey ? previous?.offset : undefined;

  if (isAtPropertyKey) {
    if (path.length === 1) {
      return {
        site: { kind: 'top-level-key', present: keysOfObject(root, editingKeyAt), colonAfter },
        replace,
      };
    }
    if (isRulePath(path, 3)) {
      const rule = nodeAt(root, ['rules', path[1]!]);
      return {
        site: { kind: 'rule-key', present: keysOfObject(rule, editingKeyAt), colonAfter },
        replace,
      };
    }
    return undefined;
  }

  if (isRulePath(path, 3) && path[2] === 'capability') {
    return { site: { kind: 'capability-value' }, replace };
  }
  if (isRulePath(path, 3) && path[2] === 'effect') {
    return { site: { kind: 'effect-value' }, replace };
  }

  const list = path[2];
  if (
    isRulePath(path, 4) &&
    (list === 'match' || list === 'exclude') &&
    typeof path[3] === 'number'
  ) {
    const capabilityNode = nodeAt(root, ['rules', path[1]!, 'capability']);
    const capability =
      capabilityNode?.type === 'string' && typeof capabilityNode.value === 'string'
        ? capabilityNode.value
        : undefined;
    return { site: { kind: 'pattern', list, capability }, replace };
  }

  return undefined;
}

/**
 * 空白と改行だけを挿入したあとの、カーソルの位置。
 *
 * Tab のインデントや Enter は、文字の入力ではなくコマンドとして空白を入れるので、補完の
 * トリガー文字にならない。その直後に候補を開くかを決めるために、挿入後の位置を求める。
 *
 * @param start 挿入された範囲の先頭
 * @param text 挿入された文字列
 * @returns 空白と改行以外を含むか、空の挿入なら `undefined`
 */
export function cursorAfterWhitespace(
  start: CursorPosition,
  text: string,
): CursorPosition | undefined {
  if (!/^[ \t\r\n]+$/.test(text)) {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  const last = lines[lines.length - 1]!;
  return lines.length === 1
    ? { line: start.line, character: start.character + text.length }
    : { line: start.line + lines.length - 1, character: last.length };
}

/** 形式に合わせて文脈を判定する。 */
export function completionRequest(
  format: PermissionsFormat,
  lines: readonly string[],
  position: CursorPosition,
): CompletionRequest | undefined {
  return format === 'yaml'
    ? yamlCompletionRequest(lines, position)
    : jsonCompletionRequest(lines, position);
}
