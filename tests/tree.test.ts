import { beforeEach, describe, expect, it } from 'vitest';
import { TreeItemCollapsibleState, Uri } from 'vscode';

import type { ScopeData } from '../src/model';
import type { ParseResult, PermissionRule } from '../src/parse';
import { PermissionsTreeDataProvider, SCOPE_CONTEXT_VALUE, type TreeNode } from '../src/tree';

let provider: PermissionsTreeDataProvider;

beforeEach(() => {
  provider = new PermissionsTreeDataProvider();
});

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    capability: 'shell',
    effect: 'allow',
    line: 1,
    matches: [],
    matchOmitted: true,
    ...overrides,
  };
}

function userScope(result: Partial<ParseResult> = {}): ScopeData {
  return {
    kind: 'user',
    key: 'user',
    label: 'User',
    file: {
      dir: '/home/test/.kiro/settings',
      filePath: '/home/test/.kiro/settings/permissions.yaml',
      exists: true,
      format: 'yaml',
    },
    content: { state: 'parsed', result: { rules: [], warnings: [], errors: [], ...result } },
  };
}

function missingWorkspaceScope(): ScopeData {
  return {
    kind: 'workspace',
    key: 'workspace:/Users/test/project',
    label: 'project',
    file: {
      dir: '/home/test/.kiro/workspace-roots/0654434d556baf69',
      filePath: '/home/test/.kiro/workspace-roots/0654434d556baf69/permissions.yaml',
      exists: false,
      format: 'yaml',
    },
    hash: '0654434d556baf69',
    resolvedVia: 'hash',
    folder: { uri: Uri.file('/Users/test/project'), name: 'project', index: 0 },
    content: { state: 'missing' },
  };
}

describe('スコープ行', () => {
  it('展開済みで、ペンシル用の contextValue を持つ', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope() });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(item.contextValue).toBe(SCOPE_CONTEXT_VALUE);
  });

  it('id はワークスペースのパス由来で安定している（ハッシュを使わない）', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: missingWorkspaceScope() });

    // ハッシュは resolvedVia の経路によって変わりうるため id には使わない。
    expect(item.id).toBe('workspace:/Users/test/project');
    expect(item.id).not.toContain('0654434d556baf69');
  });

  it('クリックしても何も起きない（展開のトグルのみ）', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope() });

    expect(item.command).toBeUndefined();
  });

  it('User と Workspace でアイコンの色が違う', () => {
    const user = provider.getTreeItem({ kind: 'scope', scope: userScope() });
    const workspace = provider.getTreeItem({ kind: 'scope', scope: missingWorkspaceScope() });

    expect(user.iconPath).toMatchObject({ id: 'milestone', color: { id: 'charts.purple' } });
    expect(workspace.iconPath).toMatchObject({ id: 'milestone', color: { id: 'icon.foreground' } });
  });

  it('読み上げラベルに件数を含む', () => {
    const item = provider.getTreeItem({ kind: 'scope', scope: userScope({ rules: [rule()] }) });

    expect(item.accessibilityInformation?.label).toBe('User, 1 rule');
  });
});

describe('ルール行', () => {
  const scope = userScope();

  it('match が複数のルールは折りたたみで、クリックしても開かない', () => {
    const target = rule({
      matchOmitted: false,
      matches: [
        { pattern: 'a', line: 3 },
        { pattern: 'b', line: 4 },
      ],
    });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 0, rule: target });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    // 子を持つ行に command を付けると展開のトグルと同時にエディタが開いてしまう。
    expect(item.command).toBeUndefined();
  });

  it('match が 1 件のルールは子を持たず、クリックで該当行にジャンプする', () => {
    const target = rule({
      effect: 'deny',
      line: 26,
      matchOmitted: false,
      matches: [{ pattern: 'sudo*', line: 28 }],
    });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 3, rule: target });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 26 },
    ]);
  });

  it('match 省略のルールも子を持たずジャンプできる', () => {
    const item = provider.getTreeItem({
      kind: 'rule',
      scope,
      ruleIndex: 1,
      rule: rule({ capability: 'web_fetch', line: 22 }),
    });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 22 },
    ]);
  });

  it('id にスコープと索引を含む', () => {
    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 4, rule: rule() });

    expect(item.id).toBe('user/4');
  });

  it('ラベルは capability、description は match の要約', () => {
    const item = provider.getTreeItem({
      kind: 'rule',
      scope,
      ruleIndex: 0,
      rule: rule({ effect: 'deny', matchOmitted: false, matches: [{ pattern: 'sudo*', line: 5 }] }),
    });

    expect(item.label).toBe('shell');
    expect(item.description).toBe('deny · sudo*');
  });
});

describe('パターン行', () => {
  it('アイコンを持たず、クリックでその行にジャンプする', () => {
    const scope = userScope();
    const item = provider.getTreeItem({
      kind: 'pattern',
      scope,
      ruleIndex: 0,
      patternIndex: 5,
      pattern: { pattern: 'npm run build', line: 8 },
    });

    expect(item.label).toBe('npm run build');
    expect(item.iconPath).toBeUndefined();
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 8 },
    ]);
  });

  it('id にスコープ・ルール・パターンの索引を含む', () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 5,
      pattern: { pattern: 'npm run build', line: 8 },
    });

    expect(item.id).toBe('user/0/5');
  });
});

describe('子ノードの構成', () => {
  async function childrenOf(scope: ScopeData): Promise<TreeNode[]> {
    return provider.getChildren({ kind: 'scope', scope });
  }

  it('ルールをそのまま並べる', async () => {
    const children = await childrenOf(userScope({ rules: [rule(), rule()] }));

    expect(children).toHaveLength(2);
    expect(children.every((child) => child.kind === 'rule')).toBe(true);
  });

  it('ファイルが無い場合は作成を促すメッセージを出す', async () => {
    const children = await childrenOf(missingWorkspaceScope());

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ kind: 'message', label: 'Click the pencil to create' });
  });

  it('パースエラーは行番号付きで並べ、クリックでその行に飛べる', async () => {
    const scope = userScope({
      errors: [
        { message: 'Sequence item without - indicator', line: 3, column: 0, code: 'MISSING_CHAR' },
      ],
    });

    const children = await childrenOf(scope);
    expect(children).toHaveLength(1);

    const item = provider.getTreeItem(children[0]!);
    expect(item.label).toBe('Line 4: Sequence item without - indicator');
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 3 },
    ]);
  });

  it('パースエラーがあるときはルールを出さない', async () => {
    const scope = userScope({
      rules: [rule()],
      errors: [{ message: 'broken', line: 0, column: 0 }],
    });

    const children = await childrenOf(scope);

    expect(children.every((child) => child.kind === 'message')).toBe(true);
  });

  it('ルールが 0 件で警告だけある場合は警告を表示する', async () => {
    const scope = userScope({ warnings: ['`rules` is not a list.'] });

    const children = await childrenOf(scope);

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ kind: 'message', label: '`rules` is not a list.' });
  });

  it('ルールが読めている場合は警告を行として出さない（tooltip に回す）', async () => {
    const scope = userScope({ rules: [rule()], warnings: ['Skipped rules[1] ...'] });

    const children = await childrenOf(scope);

    expect(children).toHaveLength(1);
    expect(children[0]?.kind).toBe('rule');
  });

  it('パターン行は葉', async () => {
    const children = await provider.getChildren({
      kind: 'pattern',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 0,
      pattern: { pattern: 'a', line: 1 },
    });

    expect(children).toEqual([]);
  });

  it('ルール行の子は match パターン', async () => {
    const target = rule({
      matchOmitted: false,
      matches: [
        { pattern: 'a', line: 3 },
        { pattern: 'b', line: 4 },
      ],
    });

    const children = await provider.getChildren({
      kind: 'rule',
      scope: userScope(),
      ruleIndex: 0,
      rule: target,
    });

    expect(
      children.map((child) => (child.kind === 'pattern' ? child.pattern.pattern : '')),
    ).toEqual(['a', 'b']);
  });
});
