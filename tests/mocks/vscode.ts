/**
 * `vscode` モジュールの最小モック。
 *
 * 拡張ホストが提供する `vscode` はテスト環境に存在しないため、`vitest.config.ts` の
 * `resolve.alias` でこのファイルに差し替える。必要になった API をその都度追加する。
 */

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
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
