import * as vscode from 'vscode';

import {
  effectAppearance,
  formatParseError,
  hasPatternChildren,
  ruleAccessibilityLabel,
  ruleDescription,
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

export type TreeNode =
  | { kind: 'scope'; scope: ScopeData }
  | { kind: 'rule'; scope: ScopeData; ruleIndex: number; rule: PermissionRule }
  | {
      kind: 'pattern';
      scope: ScopeData;
      ruleIndex: number;
      patternIndex: number;
      pattern: MatchPattern;
    }
  | {
      kind: 'message';
      scope: ScopeData;
      /** `TreeItem.id` を安定させるための識別子 */
      slug: string;
      label: string;
      icon?: Appearance;
      /** 該当行があればクリックでジャンプする */
      line?: number;
    };

interface Appearance {
  icon: string;
  color?: string;
}

function revealCommand(filePath: string, line: number): vscode.Command {
  return {
    title: 'Go to Definition',
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
      return element.rule.matches.map((pattern, patternIndex) => ({
        kind: 'pattern',
        scope: element.scope,
        ruleIndex: element.ruleIndex,
        patternIndex,
        pattern,
      }));
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
      return patternTreeItem(node.scope, node.ruleIndex, node.patternIndex, node.pattern);
    }
    return messageTreeItem(node);
  }
}

function scopeChildren(scope: ScopeData): TreeNode[] {
  const { content } = scope;

  if (content.state === 'missing') {
    return [
      {
        kind: 'message',
        scope,
        slug: 'missing',
        label: 'Click the pencil to create',
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
        icon: { icon: 'error', color: 'errorForeground' },
      },
    ];
  }

  const { errors, warnings } = content.result;

  if (errors.length > 0) {
    return errors.map((error, index) => ({
      kind: 'message',
      scope,
      slug: `error:${index}`,
      label: formatParseError(error),
      icon: { icon: 'error', color: 'errorForeground' },
      line: error.line,
    }));
  }

  const rules: TreeNode[] = rulesOf(scope).map((rule, ruleIndex) => ({
    kind: 'rule',
    scope,
    ruleIndex,
    rule,
  }));

  // 警告は tooltip にも入れているが、ルールが 1 件も読めなかった場合は
  // 何も表示されなくなるため行として出す。
  if (rules.length === 0 && warnings.length > 0) {
    return warnings.map((warning, index) => ({
      kind: 'message',
      scope,
      slug: `warning:${index}`,
      label: warning,
      icon: { icon: 'warning', color: 'editorWarning.foreground' },
    }));
  }

  return rules;
}

function scopeTreeItem(scope: ScopeData): vscode.TreeItem {
  const item = new vscode.TreeItem(scope.label, vscode.TreeItemCollapsibleState.Expanded);

  item.id = scope.key;
  item.description = scopeDescription(scope.content);
  item.contextValue = SCOPE_CONTEXT_VALUE;
  item.resourceUri = vscode.Uri.file(scope.file.filePath);

  // Workspace は白、User は紫。`milestone` は AGENT STEERING & SKILLS と同じアイコン。
  const color = scope.kind === 'user' ? 'charts.purple' : 'icon.foreground';
  item.iconPath = new vscode.ThemeIcon('milestone', new vscode.ThemeColor(color));

  item.tooltip = scopeTooltip(scope);
  item.accessibilityInformation = {
    label: `${scope.label}, ${scopeDescription(scope.content)}`,
  };

  return item;
}

function scopeTooltip(scope: ScopeData): vscode.MarkdownString {
  const lines: string[] = [];

  lines.push(scope.kind === 'user' ? '**User scope**' : '**Workspace scope**');
  lines.push('');
  lines.push(`\`${scope.file.filePath}\``);

  if (!scope.file.exists) {
    lines.push('', 'The file does not exist yet.');
  }

  if (scope.kind === 'workspace') {
    lines.push('', `Hash: \`${scope.hash}\``);
    if (scope.resolvedVia !== 'hash') {
      // 通常は `hash` で解決する。それ以外はハッシュ規則が想定と違った可能性を示す。
      lines.push(`Resolved via: \`${scope.resolvedVia}\``);
    }
  }

  if (scope.content.state === 'parsed' && scope.content.result.warnings.length > 0) {
    lines.push('', '**Warnings**');
    for (const warning of scope.content.result.warnings) {
      lines.push(`- ${warning}`);
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

  item.id = `${scope.key}/${ruleIndex}`;
  item.description = ruleDescription(rule);

  const appearance = effectAppearance(rule.effect);
  item.iconPath = new vscode.ThemeIcon(appearance.icon, new vscode.ThemeColor(appearance.color));

  item.tooltip = new vscode.MarkdownString(
    [
      `\`${rule.capability}\` / \`${rule.effect}\``,
      '',
      ...(rule.matchOmitted
        ? ['No `match` key, so this applies to everything.']
        : rule.matches.map((match) => `- \`${match.pattern}\``)),
    ].join('\n'),
  );

  item.accessibilityInformation = { label: ruleAccessibilityLabel(rule) };

  // 子を持つ行に `command` を付けると、展開のトグルと同時にエディタが開いてしまう
  // （memory.md 4.2 のクリック挙動の項）。子を持たない行だけクリックでジャンプさせる。
  if (!hasChildren) {
    item.command = revealCommand(scope.file.filePath, rule.line);
  }

  return item;
}

function patternTreeItem(
  scope: ScopeData,
  ruleIndex: number,
  patternIndex: number,
  pattern: MatchPattern,
): vscode.TreeItem {
  const item = new vscode.TreeItem(pattern.pattern, vscode.TreeItemCollapsibleState.None);

  item.id = `${scope.key}/${ruleIndex}/${patternIndex}`;
  // アイコンもペンシルも置かない。親の行に capability のアイコンがあり、階層はインデントで伝わる。
  item.tooltip = pattern.pattern;
  item.command = revealCommand(scope.file.filePath, pattern.line);

  return item;
}

function messageTreeItem(node: Extract<TreeNode, { kind: 'message' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);

  item.id = `${node.scope.key}/${node.slug}`;

  if (node.icon !== undefined) {
    item.iconPath =
      node.icon.color === undefined
        ? new vscode.ThemeIcon(node.icon.icon)
        : new vscode.ThemeIcon(node.icon.icon, new vscode.ThemeColor(node.icon.color));
  }

  item.tooltip = node.label;

  if (node.line !== undefined) {
    item.command = revealCommand(node.scope.file.filePath, node.line);
  }

  return item;
}
