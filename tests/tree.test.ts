import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeColor, ThemeIcon, TreeItemCollapsibleState, Uri } from 'vscode';

import type { ScopeData } from '../src/model';
import type { ParseResult, PermissionRule } from '../src/parse';
import { PermissionsTreeDataProvider, SCOPE_CONTEXT_VALUE, type TreeNode } from '../src/tree';
import { makeParseResult, makeRule, okValidation, validationOf } from './fixtures';

let provider: PermissionsTreeDataProvider;

beforeEach(() => {
  provider = new PermissionsTreeDataProvider();
});

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return makeRule({ line: 1, ...overrides });
}

/**
 * User スコープを作る。
 *
 * **検証結果は実際の `validatePermissions` を通す。** 手で組むと判定と表示が食い違い、
 * テストが通っても実機で崩れる。
 */
function userScope(overrides: Partial<ParseResult> = {}): ScopeData {
  const result = makeParseResult(overrides);
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
    content: { state: 'parsed', result },
    validation: validationOf(result),
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
    validation: okValidation(),
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
      matchShape: 'list',
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

  it('match が 1 件のルールも折りたたみになる（ツリー形式に統一。Q36）', () => {
    const target = rule({
      effect: 'deny',
      line: 26,
      matchShape: 'list',
      matches: [{ pattern: 'sudo*', line: 28 }],
    });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 3, rule: target });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(item.command).toBeUndefined();
  });

  it('all のルールは葉になり、クリックで該当行にジャンプする', () => {
    const item = provider.getTreeItem({
      kind: 'rule',
      scope,
      ruleIndex: 1,
      rule: rule({ capability: 'web_fetch', line: 22 }),
    });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    // パターン行を持たないため、この行にジャンプを割り当てないと飛ぶ手段が無くなる（Q36）。
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 22 },
    ]);
  });

  it('exclude だけを持つルールは子を持つのでジャンプを割り当てない', () => {
    const target = rule({
      capability: 'fs_read',
      line: 30,
      exclude: {
        patterns: [{ pattern: '.env', line: 32 }],
        shape: 'list',
        hasNonStringEntry: false,
      },
    });

    const item = provider.getTreeItem({ kind: 'rule', scope, ruleIndex: 5, rule: target });

    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(item.command).toBeUndefined();
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
      rule: rule({ effect: 'deny', matchShape: 'list', matches: [{ pattern: 'sudo*', line: 5 }] }),
    });

    expect(item.label).toBe('shell');
    expect(item.description).toBe('deny · 1 pattern');
  });
});

describe('パターン行', () => {
  it('クリックでその行にジャンプする', () => {
    const scope = userScope();
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'match',
      scope,
      ruleIndex: 0,
      patternIndex: 5,
      pattern: { pattern: 'npm run build', line: 8 },
    });

    expect(item.label).toBe('npm run build');
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(item.command?.arguments).toEqual([
      { filePath: '/home/test/.kiro/settings/permissions.yaml', line: 8 },
    ]);
  });

  it('id にスコープ・ルール・パターンの索引を含む', () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'match',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 5,
      pattern: { pattern: 'npm run build', line: 8 },
    });

    // `match` と `exclude` で名前空間を分ける（Q35）。
    expect(item.id).toBe('user/0/match/5');
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

  it('rules キーが無い場合は原因を行として出す', async () => {
    const scope = userScope({ rulesKey: 'missing' });

    const children = await childrenOf(scope);

    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      kind: 'message',
      label: 'Policy must contain a "rules" array',
    });
  });

  it('fatal のときは原因を先頭に置き、ルール行も残す', async () => {
    // `match` が単一文字列。Kiro では fatal になるが、書かれている内容は見せたい。
    const scope = userScope({
      rules: [rule({ matchShape: 'scalar', matches: [{ pattern: 'npm test', line: 2 }] })],
    });

    const children = await childrenOf(scope);

    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({
      kind: 'message',
      label: '"match" must be a string array in rule 0',
    });
    expect(children[1]?.kind).toBe('rule');
  });

  it('原因の行にはジャンプできる', async () => {
    const scope = userScope({
      rules: [rule({ line: 7, matchShape: 'scalar', matches: [{ pattern: 'x', line: 7 }] })],
    });

    const [problem] = await childrenOf(scope);
    const item = provider.getTreeItem(problem!);

    expect(item.command?.arguments?.[0]).toMatchObject({ line: 7 });
  });

  it('パターン行は葉', async () => {
    const children = await provider.getChildren({
      kind: 'pattern',
      list: 'match',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 0,
      pattern: { pattern: 'a', line: 1 },
    });

    expect(children).toEqual([]);
  });

  it('exclude のパターンも子として並ぶ（match の後）', async () => {
    const target = rule({
      capability: 'fs_write',
      matchShape: 'list',
      matches: [{ pattern: '**', line: 3 }],
      exclude: {
        patterns: [{ pattern: '.env', line: 5 }],
        shape: 'list',
        hasNonStringEntry: false,
      },
    });

    const children = await provider.getChildren({
      kind: 'rule',
      scope: userScope(),
      ruleIndex: 0,
      rule: target,
    });

    expect(
      children.map((child) =>
        child.kind === 'pattern' ? [child.list, child.pattern.pattern] : [],
      ),
    ).toEqual([
      ['match', '**'],
      ['exclude', '.env'],
    ]);
  });

  it('exclude 行はアイコンと description で区別し、id の名前空間も分ける', async () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'exclude',
      scope: userScope(),
      ruleIndex: 2,
      patternIndex: 0,
      pattern: { pattern: '.env', line: 5 },
    });

    expect(item.id).toBe('user/2/exclude/0');
    // 灰色の exclude アイコン。
    expect(item.iconPath).toEqual(
      new ThemeIcon('exclude', new ThemeColor('descriptionForeground')),
    );
    expect(item.description).toBe('exclude');
    // アイコンだけではスクリーンリーダーに伝わらない。
    expect(item.accessibilityInformation?.label).toBe('.env, exclude');
    // match 行と同じくクリックでジャンプできる。
    expect(item.command?.arguments?.[0]).toMatchObject({ line: 5 });
  });

  it('match 行は緑の歯車アイコンと match の description を持つ', async () => {
    const item = provider.getTreeItem({
      kind: 'pattern',
      list: 'match',
      scope: userScope(),
      ruleIndex: 0,
      patternIndex: 0,
      pattern: { pattern: '**', line: 3 },
    });

    // allow の緑（testing.iconPassed）とは別の色 ID を使う。
    expect(item.iconPath).toEqual(new ThemeIcon('gear', new ThemeColor('charts.green')));
    expect(item.description).toBe('match');
    expect(item.accessibilityInformation?.label).toBe('**, match');
  });

  it('ルール行の子は match パターン', async () => {
    const target = rule({
      matchShape: 'list',
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
