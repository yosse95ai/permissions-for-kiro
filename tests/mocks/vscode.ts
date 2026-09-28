/**
 * `vscode` モジュールの最小モック。
 *
 * 拡張ホストが提供する `vscode` はテスト環境に存在しないため、`vitest.config.mts` の
 * `resolve.alias` でこのファイルに差し替える。必要になった API をその都度追加する。
 *
 * なお `tsc` は alias を知らないため、テストコード側の型は本物の `@types/vscode` で
 * 検査される。モックが公式型に適合していない箇所は型エラーとして現れる。
 */

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor,
  ) {}
}

export class MarkdownString {
  constructor(public value: string = '') {}
}

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface AccessibilityInformation {
  label: string;
  role?: string;
}

export class TreeItem {
  id?: string;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  iconPath?: ThemeIcon;
  command?: Command;
  contextValue?: string;
  resourceUri?: Uri;
  accessibilityInformation?: AccessibilityInformation;

  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly fsPath: string,
  ) {}

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class Selection extends Range {}

/**
 * `CompletionItemKind` のうち、この拡張が使う値と、比較に使いそうな値だけ。
 *
 * 数値は `@types/vscode` 1.94.0 の定義と同じにしている（アイコンの種類を数値で比べても
 * 本物とずれないように）。
 */
export enum CompletionItemKind {
  Text = 0,
  Property = 9,
  Value = 11,
  Snippet = 14,
  EnumMember = 19,
}

export class SnippetString {
  constructor(public value: string = '') {}
}

/**
 * `CompletionItem` のモック。プロバイダーが設定したプロパティをそのまま持つだけ。
 *
 * `range` は本物と同じく、`Range` か `{ inserting, replacing }` のどちらかを受ける。
 */
export class CompletionItem {
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  range?: Range | { inserting: Range; replacing: Range };
  command?: Command;

  constructor(
    public label: string,
    public kind?: CompletionItemKind,
  ) {}
}

export class EventEmitter<T> {
  private readonly listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  fire(value: T): void {
    // 通知中にリスナーが dispose される場合に備えてコピーしてから回す。
    for (const listener of this.listeners.slice()) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}

export class RelativePattern {
  constructor(
    public readonly baseUri: Uri,
    public readonly pattern: string,
  ) {}
}

/**
 * `FileSystemWatcher` のモック。
 *
 * テストからイベントを発火できるように、登録されたリスナーを保持する。
 */
export class FileSystemWatcherMock {
  // 実際は変更された Uri が渡るが、テストでは値を使わないため `unknown` にしている。
  readonly onDidCreateEmitter = new EventEmitter<unknown>();
  readonly onDidChangeEmitter = new EventEmitter<unknown>();
  readonly onDidDeleteEmitter = new EventEmitter<unknown>();
  disposed = false;

  constructor(public readonly watched: RelativePattern) {}

  readonly onDidCreate = this.onDidCreateEmitter.event;
  readonly onDidChange = this.onDidChangeEmitter.event;
  readonly onDidDelete = this.onDidDeleteEmitter.event;

  dispose(): void {
    this.disposed = true;
  }
}

/** `createFileSystemWatcher` で作られた watcher。テストの検証用。 */
export const createdWatchers: FileSystemWatcherMock[] = [];

const workspaceFoldersEmitter = new EventEmitter<void>();
const saveEmitter = new EventEmitter<{ uri: Uri }>();
const changeEmitter = new EventEmitter<unknown>();

/** テストからドキュメントの変更を発火する。中身はテストが組み立てる。 */
export function fireDidChangeTextDocument(event: unknown): void {
  changeEmitter.fire(event);
}

/** `commands.executeCommand` で実行されたコマンドの ID。 */
export const executedCommands: string[] = [];

export interface DocumentMock {
  uri: Uri;
  lineCount: number;
}

/** `showTextDocument` が返すエディタ。カーソル移動と `revealRange` を記録する。 */
export class TextEditorMock {
  selection: Selection | undefined;
  readonly revealed: Array<{ range: Range; type: TextEditorRevealType }> = [];

  constructor(public readonly document: DocumentMock) {}

  revealRange(range: Range, type: TextEditorRevealType): void {
    this.revealed.push({ range, type });
  }
}

/**
 * `openTextDocument` の振る舞いをテストから制御する。
 *
 * `lineCount` は `revealLocation` の行の丸め込みを確かめるために使う。
 */
export const documentState = {
  lineCount: 1,
  /** 設定すると `openTextDocument` が throw する */
  failWith: undefined as Error | undefined,
};

/** `showErrorMessage` に渡されたメッセージ。 */
export const shownErrors: string[] = [];

/** `showTextDocument` で開かれたエディタと、そのとき渡されたオプション。 */
export const openedEditors: TextEditorMock[] = [];
export const showTextDocumentOptions: Array<{ preview?: boolean } | undefined> = [];

type CommandHandler = (...args: never[]) => unknown;

/** `registerCommand` で登録されたハンドラ。 */
export const registeredCommands = new Map<string, CommandHandler>();

/**
 * 登録済みのコマンドを実行する。
 *
 * `Reflect.apply` を使うのは、型アサーションを避けるため（`no-unsafe-type-assertion`）。
 */
export async function executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = registeredCommands.get(command);
  if (handler === undefined) {
    throw new Error(`command is not registered: ${command}`);
  }
  return Reflect.apply(handler, undefined, args);
}

/** `createTreeView` で作られたビュー。 */
export const createdTreeViews: TreeViewMock[] = [];

export class TreeViewMock {
  disposed = false;

  constructor(
    public readonly id: string,
    public readonly options: unknown,
  ) {}

  dispose(): void {
    this.disposed = true;
  }
}

/**
 * `registerCompletionItemProvider` で登録されたプロバイダー。
 *
 * selector とトリガー文字を検証できるように、引数をそのまま記録する。dispose されると
 * 一覧から取り除く（`registeredCommands` と同じく、解放漏れをテストで検出するため）。
 */
export interface RegisteredCompletionProvider {
  selector: unknown;
  provider: unknown;
  triggerCharacters: string[];
}

export const registeredCompletionProviders: RegisteredCompletionProvider[] = [];

/** テストからワークスペースフォルダの変更を発火する。 */
export function fireWorkspaceFoldersChange(): void {
  workspaceFoldersEmitter.fire();
}

/** テストからドキュメントの保存を発火する。 */
export function fireDidSaveTextDocument(fsPath: string): void {
  saveEmitter.fire({ uri: Uri.file(fsPath) });
}

/** テスト間で状態を持ち越さないためのリセット。 */
export function resetMocks(): void {
  createdWatchers.length = 0;
  workspace.workspaceFolders = undefined;
  documentState.lineCount = 1;
  documentState.failWith = undefined;
  shownErrors.length = 0;
  openedEditors.length = 0;
  showTextDocumentOptions.length = 0;
  registeredCommands.clear();
  createdTreeViews.length = 0;
  registeredCompletionProviders.length = 0;
  executedCommands.length = 0;
  window.activeTextEditor = undefined;
}

/** テストから差し替えられるようにミュータブルにしている。 */
export const workspace = {
  workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
  openTextDocument: async (uri: Uri): Promise<DocumentMock> => {
    if (documentState.failWith !== undefined) {
      throw documentState.failWith;
    }
    return { uri, lineCount: documentState.lineCount };
  },
  createFileSystemWatcher: (pattern: RelativePattern): FileSystemWatcherMock => {
    const watcher = new FileSystemWatcherMock(pattern);
    createdWatchers.push(watcher);
    return watcher;
  },
  onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
  onDidSaveTextDocument: saveEmitter.event,
  onDidChangeTextDocument: changeEmitter.event,
};

export const window = {
  /** テストから差し替える。`{ document, selections }` だけを使う */
  activeTextEditor: undefined as { document: unknown; selections: unknown[] } | undefined,
  showErrorMessage: async (message: string) => {
    shownErrors.push(message);
    return message;
  },
  showTextDocument: async (
    document: DocumentMock,
    options?: { preview?: boolean },
  ): Promise<TextEditorMock> => {
    const editor = new TextEditorMock(document);
    openedEditors.push(editor);
    showTextDocumentOptions.push(options);
    return editor;
  },
  createTreeView: (id: string, options: unknown): TreeViewMock => {
    const view = new TreeViewMock(id, options);
    createdTreeViews.push(view);
    return view;
  },
};

export const commands = {
  executeCommand: async (command: string): Promise<undefined> => {
    executedCommands.push(command);
    return undefined;
  },
  registerCommand: (command: string, handler: CommandHandler) => {
    registeredCommands.set(command, handler);
    return {
      dispose: () => {
        registeredCommands.delete(command);
      },
      command,
    };
  },
};

export const languages = {
  registerCompletionItemProvider: (
    selector: unknown,
    provider: unknown,
    ...triggerCharacters: string[]
  ) => {
    const registration: RegisteredCompletionProvider = { selector, provider, triggerCharacters };
    registeredCompletionProviders.push(registration);
    return {
      dispose: () => {
        const index = registeredCompletionProviders.indexOf(registration);
        if (index >= 0) {
          registeredCompletionProviders.splice(index, 1);
        }
      },
    };
  },
};

/**
 * `vscode.l10n` のモック。
 *
 * **原文をそのまま返す**（`{0}` の埋め込みだけ行う）。実際の拡張ホストでも、対象ロケールの
 * バンドルが無ければ第一引数が返る。この挙動に合わせているので、テストの期待値は英語のまま
 * 書ける。日本語訳そのものの検証は `l10n/bundle.l10n.ja.json` のキーの網羅性で担保する。
 *
 * 名前付きプレースホルダ（`{name}`）は使っていないため実装しない。
 */
export const l10n = {
  bundle: undefined as Record<string, string> | undefined,
  uri: undefined as Uri | undefined,
  t(message: string, ...args: Array<string | number | boolean>): string {
    return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
      const value = args[Number(index)];
      return value === undefined ? placeholder : String(value);
    });
  },
};
