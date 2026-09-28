import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { type Candidate, type CandidateKind, completionCandidates } from './completionCandidates';
import { completionRequest, cursorAfterWhitespace, type CursorPosition } from './completionContext';
import {
  PERMISSIONS_FILES,
  type PermissionsFormat,
  userScopeDir,
  workspaceRootsDir,
} from './permissionsFile';
import { isPermissionsFile } from './watch';

/**
 * permissions ファイルを編集するときの補完を登録する層。
 *
 * 文脈の判定（`completionContext.ts`）と候補（`completionCandidates.ts`）は vscode に
 * 依存しない。ここでは selector の組み立てと、`CompletionItem` への変換だけを行う。
 *
 * 補完は候補を出すだけで、ファイルを書くのも候補を採用するのも利用者。拡張がファイルを
 * 書き換えることはない。
 */

/**
 * 単語がない位置（`- ` や `capability: ` の直後、JSON の空の `""`）で候補を開くための文字。
 *
 * トリガー文字で呼ばれるのは、それを登録したプロバイダーだけなので、他の言語機能が余計に
 * 呼ばれることはない。文脈が合わない位置では何も返さない。
 */
const TRIGGER_CHARACTERS: Record<PermissionsFormat, string> = {
  yaml: ' ',
  json: '"',
};

const ITEM_KINDS: Record<CandidateKind, vscode.CompletionItemKind> = {
  key: vscode.CompletionItemKind.Property,
  value: vscode.CompletionItemKind.EnumMember,
  pattern: vscode.CompletionItemKind.Snippet,
};

/** 候補を確定したあとに、続けて値の候補を開くコマンド。 */
const TRIGGER_SUGGEST: vscode.Command = {
  command: 'editor.action.triggerSuggest',
  title: 'Trigger Suggest',
};

/** 補完に必要な分だけの `TextDocument`。テストから行の配列で渡せるようにしている。 */
export interface LineSource {
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
}

/** 形式に対応するファイル名。`PERMISSIONS_FILES` にない名前になると型エラーになる。 */
function fileNameOf(format: PermissionsFormat): (typeof PERMISSIONS_FILES)[number] {
  return `permissions.${format}`;
}

/**
 * 対象ファイルだけに一致する selector。
 *
 * - `~/.kiro/settings/permissions.{yaml,json}`
 * - `~/.kiro/workspace-roots/<hash>/permissions.{yaml,json}`（ハッシュディレクトリの直下だけ）
 *
 * ファイルはワークスペースの外にあるので、`RelativePattern` に絶対パスの `Uri` を渡す。
 * 絶対パスを glob の文字列に埋め込むと、Windows の `\` で壊れる。大文字小文字と区切り文字の
 * 違いは、本体の照合が吸収する。`language` を入れるので、`files.associations` で別の言語に
 * 割り当てられたファイルは対象外になる。
 */
export function completionSelector(
  format: PermissionsFormat,
  home: string,
): vscode.DocumentFilter[] {
  const fileName = fileNameOf(format);
  return [
    {
      scheme: 'file',
      language: format,
      pattern: new vscode.RelativePattern(vscode.Uri.file(userScopeDir(home)), fileName),
    },
    {
      scheme: 'file',
      language: format,
      // `*` はパスの区切りをまたがないので、ハッシュディレクトリの直下だけに一致する。
      pattern: new vscode.RelativePattern(
        vscode.Uri.file(workspaceRootsDir(home)),
        `*/${fileName}`,
      ),
    },
  ];
}

function toItem(candidate: Candidate, range: vscode.Range, typed: string): vscode.CompletionItem {
  const kind = ITEM_KINDS[candidate.kind];
  const item = new vscode.CompletionItem(candidate.label, kind);
  item.range = range;
  item.sortText = candidate.sortText;
  item.insertText = candidate.snippet
    ? new vscode.SnippetString(candidate.insertText)
    : candidate.insertText;

  // 置換範囲は開き引用符から始まる。エディタは範囲の先頭からカーソルまでの文字列で候補を
  // 絞るので、`"s` と打っているときに `shell` が消えないように、絞り込みの文字列にも付ける。
  const quote = typed[0];
  if (quote === '"' || quote === "'") {
    item.filterText = `${quote}${candidate.label}`;
  }

  if (candidate.detail !== undefined) {
    item.detail = candidate.detail;
  }
  if (candidate.documentation !== undefined) {
    item.documentation = new vscode.MarkdownString(candidate.documentation);
  }
  if (candidate.triggerSuggest) {
    item.command = TRIGGER_SUGGEST;
  }
  return item;
}

/**
 * カーソル位置の補完の候補。出す候補がなければ `undefined`（そのときは単語ベースの候補が出る）。
 */
export function completionItems(
  format: PermissionsFormat,
  document: LineSource,
  position: CursorPosition,
): vscode.CompletionItem[] | undefined {
  const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
  const request = completionRequest(format, lines, position);
  if (request === undefined) {
    return undefined;
  }

  const candidates = completionCandidates(request.site, format);
  if (candidates.length === 0) {
    return undefined;
  }

  const range = new vscode.Range(
    new vscode.Position(position.line, request.replace.start),
    new vscode.Position(position.line, request.replace.end),
  );
  const typed = lines[position.line]!.slice(request.replace.start, position.character);
  return candidates.map((candidate) => toItem(candidate, range, typed));
}

/** 変更の監視に必要な分だけの `TextDocument`。 */
export interface WatchedDocument extends LineSource {
  readonly languageId: string;
  readonly uri: { readonly scheme: string; readonly fsPath: string };
}

/**
 * 補完の対象のファイルなら、その形式を返す。
 *
 * selector と同じ条件（言語、`file` スキーム、User スコープかハッシュディレクトリの直下）を、
 * 変更イベントのために `isPermissionsFile()` で判定する。
 */
export function permissionsFormatOf(
  document: WatchedDocument,
  home: string,
): PermissionsFormat | undefined {
  const format: PermissionsFormat | undefined =
    document.languageId === 'yaml' ? 'yaml' : document.languageId === 'json' ? 'json' : undefined;
  const filePath = document.uri.fsPath;
  if (
    format === undefined ||
    document.uri.scheme !== 'file' ||
    path.basename(filePath) !== fileNameOf(format) ||
    !isPermissionsFile(filePath, home)
  ) {
    return undefined;
  }
  return format;
}

/** 変更イベントのうち、判定に使う部分。 */
export interface IndentChange {
  document: WatchedDocument;
  /** `undefined` 以外（元に戻す・やり直し）なら開かない */
  reason: unknown;
  contentChanges: readonly { range: { start: CursorPosition }; text: string }[];
}

/**
 * Tab や Enter で空白だけを入れた直後に、候補を開くべきか。
 *
 * - 空白と改行だけの 1 つの挿入であること（元に戻す・やり直しは除く）
 * - YAML で空白 1 文字だけの挿入は、トリガー文字として補完がすでに開くので除く
 * - 挿入後の位置に、この拡張が出す候補があること
 */
export function shouldOpenSuggestAfter(change: IndentChange, home: string): boolean {
  const [content] = change.contentChanges;
  if (change.reason !== undefined || change.contentChanges.length !== 1 || content === undefined) {
    return false;
  }
  const format = permissionsFormatOf(change.document, home);
  if (format === undefined || (format === 'yaml' && content.text === TRIGGER_CHARACTERS.yaml)) {
    return false;
  }
  const position = cursorAfterWhitespace(content.range.start, content.text);
  return position !== undefined && completionItems(format, change.document, position) !== undefined;
}

/**
 * Tab のインデントと Enter のあとに候補を開く。
 *
 * どちらも文字の入力ではないので、トリガー文字では補完が開かない。拡張は一覧を開くだけで、
 * ファイルには何も書かない。
 */
function openSuggestAfterIndent(home: string): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument((event) => {
    const editor = vscode.window.activeTextEditor;
    if (
      editor === undefined ||
      editor.document !== event.document ||
      editor.selections.length !== 1 ||
      !shouldOpenSuggestAfter(event, home)
    ) {
      return;
    }
    void vscode.commands.executeCommand(TRIGGER_SUGGEST.command);
  });
}

/** YAML と JSON の補完を登録する。 */
export function registerCompletion(home: string = os.homedir()): vscode.Disposable[] {
  const formats: PermissionsFormat[] = ['yaml', 'json'];
  return [
    ...formats.map((format) =>
      vscode.languages.registerCompletionItemProvider(
        completionSelector(format, home),
        {
          provideCompletionItems: (document: LineSource, position: CursorPosition) =>
            completionItems(format, document, position),
        },
        TRIGGER_CHARACTERS[format],
      ),
    ),
    openSuggestAfterIndent(home),
  ];
}
