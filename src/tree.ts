import * as vscode from 'vscode';

import {
  type Appearance,
  EXCLUDE_APPEARANCE,
  formatParseError,
  hasPatternChildren,
  isScopeInactive,
  MATCH_APPEARANCE,
  ruleAccessibilityLabel,
  ruleAppearance,
  ruleDescription,
  type RuleState,
  ruleStateOf,
  scopeDescription,
} from './display';
import { loadScopes, rulesOf, type ScopeData } from './model';
import type { MatchPattern, PermissionRule } from './parse';

export const VIEW_ID = 'permissionsForKiro.view';

/** スコープ行の `contextValue`。ペンシルを出す `when` 節（`viewItem == ...`）で使う。 */
export const SCOPE_CONTEXT_VALUE = 'permissionsForKiro.scope';

export const REVEAL_LOCATION_COMMAND = 'permissionsForKiro.revealLocation';

/** クリックで開くファイルと行を表す。`revealLocation` コマンドの引数。 */
export interface RevealTarget {
  filePath: string;
  /** 0-based */
  line: number;
}

export type PatternListKind = 'match' | 'exclude';

export type TreeNode =
  | { kind: 'scope'; scope: ScopeData }
  | { kind: 'rule'; scope: ScopeData; ruleIndex: number; rule: PermissionRule }
  | {
      kind: 'pattern';
      scope: ScopeData;
      ruleIndex: number;
      patternIndex: number;
      pattern: MatchPattern;
      /** どちらのリストのパターンか。`TreeItem.id` の衝突を避けるためにも必要（Q35） */
      list: PatternListKind;
    }
  | {
      kind: 'message';
      scope: ScopeData;
      /** `TreeItem.id` を安定させるための識別子 */
      slug: string;
      label: string;
      /**
       * tooltip に出す全文。`label` を短縮している場合に設定する（Q37 = D）。
       *
       * パースエラーの `label` は 1 行目だけに削っているため、スニペットとキャレットを
       * 含む原文はここで保持する。省略時は `label` をそのまま tooltip にする。
       */
      detail?: string;
      icon?: Appearance;
      /** 該当行があればクリックでジャンプする */
      line?: number;
    };

/** `Appearance` から `ThemeIcon` を作る。色が無ければ既定色になる。 */
function themeIcon(appearance: Appearance): vscode.ThemeIcon {
  return appearance.color === undefined
    ? new vscode.ThemeIcon(appearance.icon)
    : new vscode.ThemeIcon(appearance.icon, new vscode.ThemeColor(appearance.color));
}

function revealCommand(filePath: string, line: number): vscode.Command {
  return {
    title: vscode.l10n.t('Go to Definition'),
    command: REVEAL_LOCATION_COMMAND,
    arguments: [{ filePath, line } satisfies RevealTarget],
  };
}

export class PermissionsTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  /** ルート要素の読み込みは重いので、`refresh()` まで結果を保持する。 */
  private scopesPromise: Promise<ScopeData[]> | undefined;

  refresh(): void {
    this.scopesPromise = undefined;
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private scopes(): Promise<ScopeData[]> {
    this.scopesPromise ??= loadScopes();
    return this.scopesPromise;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element === undefined) {
      const scopes = await this.scopes();
      return scopes.map((scope) => ({ kind: 'scope', scope }));
    }

    if (element.kind === 'scope') {
      return scopeChildren(element.scope);
    }

    if (element.kind === 'rule') {
      // `match` を先に、`exclude` を後に。YAML の記載順と同じ並びになる。
      return [
        ...patternNodes(element.scope, element.ruleIndex, element.rule.matches, 'match'),
        ...patternNodes(element.scope, element.ruleIndex, element.rule.exclude.patterns, 'exclude'),
      ];
    }

    // パターン行とメッセージ行は葉。
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'scope') {
      return scopeTreeItem(node.scope);
    }
    if (node.kind === 'rule') {
      return ruleTreeItem(node.scope, node.ruleIndex, node.rule);
    }
    if (node.kind === 'pattern') {
      return patternTreeItem(node);
    }
    return messageTreeItem(node);
  }
}

const ERROR_ICON = { icon: 'error', color: 'errorForeground' };

function scopeChildren(scope: ScopeData): TreeNode[] {
  const { content, validation } = scope;

  if (content.state === 'missing') {
    return [
      {
        kind: 'message',
        scope,
        slug: 'missing',
        label: vscode.l10n.t('Click the pencil to create'),
      },
    ];
  }

  if (content.state === 'read-error') {
    return [
      {
        kind: 'message',
        scope,
        slug: 'read-error',
        label: content.message,
        icon: ERROR_ICON,
      },
    ];
  }

  const { errors } = content.result;

  if (errors.length > 0) {
    return errors.map((error, index) => ({
      kind: 'message',
      scope,
      slug: `error:${index}`,
      label: formatParseError(error),
      // ラベルは 1 行目だけに削っているので、原文は tooltip に回す（Q37 = D）。
      detail: error.message,
      icon: ERROR_ICON,
      line: error.line,
    }));
  }

  // 設定が読み込まれていない原因を先頭に置く。**クリックで原因の行へジャンプできる**
  // ようにするのが要点（Q33 の案 b）。
  const problems: TreeNode[] = validation.fatal.map((problem, index) => ({
    kind: 'message',
    scope,
    slug: `fatal:${index}`,
    label: problem.message,
    icon: ERROR_ICON,
    line: problem.line,
  }));

  // fatal でもルール行は残す。ファイルに何が書かれているかを確認したい用途があるため。
  // 見た目は `ruleTreeItem` 側で無彩色に落とす。
  const rules: TreeNode[] = rulesOf(scope).map((rule, ruleIndex) => ({
    kind: 'rule',
    scope,
    ruleIndex,
    rule,
  }));

  return [...problems, ...rules];
}

function scopeTreeItem(scope: ScopeData): vscode.TreeItem {
  const item = new vscode.TreeItem(scope.label, vscode.TreeItemCollapsibleState.Expanded);

  const description = scopeDescription(scope.content, scope.validation);

  item.id = scope.key;
  item.description = description;
  item.contextValue = SCOPE_CONTEXT_VALUE;
  item.resourceUri = vscode.Uri.file(scope.file.filePath);

  // Workspace は白、User は紫。`milestone` は AGENT STEERING & SKILLS と同じアイコン。
  // 読み込まれていないスコープは赤にして、折りたたんでいても異常が分かるようにする（Q33）。
  const color = scopeInactive(scope)
    ? 'errorForeground'
    : scope.kind === 'user'
      ? 'charts.purple'
      : 'icon.foreground';
  item.iconPath = new vscode.ThemeIcon('milestone', new vscode.ThemeColor(color));

  item.tooltip = scopeTooltip(scope);
  item.accessibilityInformation = { label: `${scope.label}, ${description}` };

  return item;
}

function scopeInactive(scope: ScopeData): boolean {
  return isScopeInactive(scope.content, scope.validation);
}

function scopeTooltip(scope: ScopeData): vscode.MarkdownString {
  const lines: string[] = [];

  lines.push(
    scope.kind === 'user'
      ? `**${vscode.l10n.t('User scope')}**`
      : `**${vscode.l10n.t('Workspace scope')}**`,
  );

  // ワークスペースのパスを最初に出す（Q48）。ラベルは `folder.name` なので、マルチルートで
  // 同名のフォルダを開くと行が区別できなくなる。ハッシュは診断用で、人間には逆引きできない。
  if (scope.kind === 'workspace') {
    lines.push('', `${vscode.l10n.t('Folder:')} \`${scope.folder.uri.fsPath}\``);
  }

  // 空行を挟むのは Markdown の段落として分けるため（挟まないと 1 行に連結される）。
  lines.push('', `${vscode.l10n.t('File:')} \`${scope.file.filePath}\``);

  if (!scope.file.exists) {
    lines.push('', vscode.l10n.t('The file does not exist yet.'));
  }

  if (scope.kind === 'workspace') {
    lines.push('', `${vscode.l10n.t('Hash:')} \`${scope.hash}\``);
    if (scope.resolvedVia !== 'hash') {
      // 通常は `hash` で解決する。それ以外はハッシュ規則が想定と違った可能性を示す。
      // `resolvedVia` の値そのものは内部の識別子なので訳さない（Q31）。
      lines.push(`${vscode.l10n.t('Resolved via:')} \`${scope.resolvedVia}\``);
    }
  }

  const { fatal, skipped } = scope.validation;

  if (fatal.length > 0) {
    lines.push('', `**${vscode.l10n.t('Not loaded')}**`);
    lines.push(vscode.l10n.t('Kiro could not load this file, so none of these rules apply.'));
    // 原因の本文は英語のまま。Kiro 本体の通知と突き合わせられるようにする（Q31）。
    for (const problem of fatal) {
      lines.push(`- ${problem.message}`);
    }
  }

  if (skipped.size > 0) {
    lines.push('', `**${vscode.l10n.t('Skipped rules')}**`);
    for (const problem of skipped.values()) {
      lines.push(`- ${problem.message}`);
    }
  }

  return new vscode.MarkdownString(lines.join('\n'));
}

function ruleTreeItem(scope: ScopeData, ruleIndex: number, rule: PermissionRule): vscode.TreeItem {
  const hasChildren = hasPatternChildren(rule);
  const item = new vscode.TreeItem(
    rule.capability,
    hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
  );

  const state = ruleStateOf(ruleIndex, scope.validation, scopeInactive(scope));

  item.id = `${scope.key}/${ruleIndex}`;
  item.description = ruleDescription(rule, state);

  item.iconPath = themeIcon(ruleAppearance(rule, state));

  item.tooltip = ruleTooltip(scope, ruleIndex, rule, state);
  item.accessibilityInformation = { label: ruleAccessibilityLabel(rule, state) };

  // 子を持つ行に `command` を付けると、展開のトグルと同時にエディタが開いてしまう
  // （memory.md 4.2 のクリック挙動の項）。
  //
  // **子を持たないのは `all` のルール（`match` 省略かつ `exclude` 無し）だけ**（Q36）。
  // この行にだけジャンプを割り当てる。そうしないと、パターン行を持たないルールへ飛ぶ手段が
  // 一切なくなる。
  if (!hasChildren) {
    item.command = revealCommand(scope.file.filePath, rule.line);
  }

  return item;
}

function ruleTooltip(
  scope: ScopeData,
  ruleIndex: number,
  rule: PermissionRule,
  state: RuleState,
): vscode.MarkdownString {
  const lines: string[] = [];

  // 効いていない理由を先頭に置く。パターンの一覧より重要な情報なので上に出す。
  if (state === 'skipped') {
    const problem = scope.validation.skipped.get(ruleIndex);
    lines.push(
      `**${vscode.l10n.t('Skipped by Kiro')}**`,
      vscode.l10n.t('This rule has no effect until the file is fixed.'),
    );
    if (problem !== undefined) {
      lines.push('', `\`${problem.message}\``);
    }
    lines.push('');
  } else if (state === 'inactive') {
    lines.push(
      `**${vscode.l10n.t('Not loaded')}**`,
      vscode.l10n.t('Kiro could not load this file, so none of these rules apply.'),
      '',
    );
  }

  lines.push(`\`${rule.capability}\` / \`${rule.effect}\``, '');

  if (rule.matchShape === 'omitted') {
    lines.push('No `match` key, so this applies to everything.');
  } else {
    lines.push(...rule.matches.map((match) => `- \`${match.pattern}\``));
  }

  // `exclude` は行としては出していないので、少なくとも tooltip では見せる。
  if (rule.exclude.patterns.length > 0) {
    lines.push('', '`exclude`');
    lines.push(...rule.exclude.patterns.map((entry) => `- \`${entry.pattern}\``));
  }

  return new vscode.MarkdownString(lines.join('\n'));
}

function patternNodes(
  scope: ScopeData,
  ruleIndex: number,
  patterns: MatchPattern[],
  list: PatternListKind,
): TreeNode[] {
  return patterns.map((pattern, patternIndex) => ({
    kind: 'pattern',
    scope,
    ruleIndex,
    patternIndex,
    pattern,
    list,
  }));
}

function patternTreeItem(node: Extract<TreeNode, { kind: 'pattern' }>): vscode.TreeItem {
  const { scope, ruleIndex, patternIndex, pattern, list } = node;
  const item = new vscode.TreeItem(pattern.pattern, vscode.TreeItemCollapsibleState.None);

  // `match` と `exclude` で名前空間を分ける。同じ添字が両方に存在するため（Q35）。
  item.id = `${scope.key}/${ruleIndex}/${list}/${patternIndex}`;

  if (list === 'exclude') {
    // 灰色の `exclude` アイコン。`match` の歯車と形も色も違うので区別できる。
    item.iconPath = themeIcon(EXCLUDE_APPEARANCE);
    // `exclude` は YAML のキー名なので訳さない（Q31 の識別子の扱い）。
    item.description = 'exclude';
    item.accessibilityInformation = { label: `${pattern.pattern}, exclude` };
    item.tooltip = new vscode.MarkdownString(
      [`\`${pattern.pattern}\``, '', vscode.l10n.t('Excluded from this rule.')].join('\n'),
    );
  } else {
    item.iconPath = themeIcon(MATCH_APPEARANCE);
    // `exclude` と対称にする。`match` も YAML のキー名なので訳さない。
    item.description = 'match';
    item.accessibilityInformation = { label: `${pattern.pattern}, match` };
    item.tooltip = pattern.pattern;
  }

  item.command = revealCommand(scope.file.filePath, pattern.line);

  return item;
}

function messageTreeItem(node: Extract<TreeNode, { kind: 'message' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);

  item.id = `${node.scope.key}/${node.slug}`;

  if (node.icon !== undefined) {
    item.iconPath = themeIcon(node.icon);
  }

  item.tooltip = node.detail ?? node.label;

  if (node.line !== undefined) {
    item.command = revealCommand(node.scope.file.filePath, node.line);
  }

  return item;
}
