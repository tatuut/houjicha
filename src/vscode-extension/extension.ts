/**
 * ほうじ茶（Houjicha）- VS Code 拡張機能
 * Language Server クライアント + インライン補完 + プレビュー
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionContext, workspace } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { parse } from '../language/parser';
import { renderToHtml, getPreviewHtml, RenderFormat } from '../language/renderer';

let client: LanguageClient;
let previewPanel: vscode.WebviewPanel | undefined;

// TreeViewのアイテム
class HoujichaTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly filePath?: string,
    public readonly line?: number,
    public readonly itemType?: 'file' | 'namespace' | 'claim' | 'requirement' | 'effect',
    public readonly status?: string
  ) {
    super(label, collapsibleState);

    // アイコンとコンテキスト設定
    if (itemType === 'file') {
      this.iconPath = new vscode.ThemeIcon('file');
      this.contextValue = 'houjichaFile';
    } else if (itemType === 'namespace') {
      this.iconPath = new vscode.ThemeIcon('folder');
    } else if (itemType === 'claim') {
      this.iconPath = new vscode.ThemeIcon('law');
    } else if (itemType === 'requirement') {
      const icon = status === '✅' ? 'pass' :
                   status === '❌' ? 'error' :
                   status === '⚠️' ? 'warning' : 'circle-outline';
      this.iconPath = new vscode.ThemeIcon(icon);
    } else if (itemType === 'effect') {
      this.iconPath = new vscode.ThemeIcon('arrow-right');
    }

    // クリックでファイルを開く
    if (filePath && line !== undefined) {
      this.command = {
        command: 'houjicha.openLocation',
        title: 'Open',
        arguments: [filePath, line],
      };
    }
  }
}

// TreeDataProvider
class HoujichaTreeProvider implements vscode.TreeDataProvider<HoujichaTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HoujichaTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: HoujichaTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: HoujichaTreeItem): Promise<HoujichaTreeItem[]> {
    if (!element) {
      // ルート: ワークスペース内の全.houjichaファイル
      return this.getHoujichaFiles();
    }

    if (element.itemType === 'file' && element.filePath) {
      // ファイル: その中のNamespaceとClaim
      return this.getFileContents(element.filePath);
    }

    return [];
  }

  private async getHoujichaFiles(): Promise<HoujichaTreeItem[]> {
    const files = await vscode.workspace.findFiles('**/*.{houjicha,hcha}');
    return files.map(file => {
      const relativePath = vscode.workspace.asRelativePath(file);
      return new HoujichaTreeItem(
        relativePath,
        vscode.TreeItemCollapsibleState.Collapsed,
        file.fsPath,
        0,
        'file'
      );
    });
  }

  private async getFileContents(filePath: string): Promise<HoujichaTreeItem[]> {
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      const { document: ast } = parse(text);

      const items: HoujichaTreeItem[] = [];

      for (const child of ast.children) {
        if (child.type === 'Namespace') {
          const nsItem = new HoujichaTreeItem(
            `::${child.name}`,
            vscode.TreeItemCollapsibleState.Expanded,
            filePath,
            child.range.start.line,
            'namespace'
          );
          items.push(nsItem);

          // Namespace内のClaim
          for (const nsChild of child.children) {
            if (nsChild.type === 'Claim') {
              items.push(this.createClaimItem(nsChild, filePath));
            }
          }
        } else if (child.type === 'Claim') {
          items.push(this.createClaimItem(child, filePath));
        }
      }

      return items;
    } catch (error) {
      return [new HoujichaTreeItem(
        `エラー: ${error}`,
        vscode.TreeItemCollapsibleState.None
      )];
    }
  }

  private createClaimItem(claim: any, filePath: string): HoujichaTreeItem {
    // 充足状況を計算
    let fulfilled = 0, total = 0;
    for (const req of claim.requirements || []) {
      total++;
      if (req.concluded === 'positive' || req.fact) fulfilled++;
    }
    const summary = total > 0 ? ` [${fulfilled}/${total}]` : '';
    const ref = claim.reference?.citation ? `（${claim.reference.citation}）` : '';

    const item = new HoujichaTreeItem(
      `#${claim.name}${ref}${summary}`,
      vscode.TreeItemCollapsibleState.None,
      filePath,
      claim.range.start.line,
      'claim'
    );

    // 説明テキスト
    if (claim.effect) {
      item.description = `>> ${claim.effect.content}`;
    }

    return item;
  }
}

// インライン補完プロバイダー
class HoujichaInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    // 1. 記号ペアのGhost補完（優先）
    // ~> (理由)
    if (textBeforeCursor.endsWith('~')) {
      return [new vscode.InlineCompletionItem('>', new vscode.Range(position, position))];
    }
    // => (帰結) - ただし既に => の場合は出さない
    if (textBeforeCursor.endsWith('=') && !textBeforeCursor.endsWith('<=') && !textBeforeCursor.endsWith('=>')) {
      return [new vscode.InlineCompletionItem('>', new vscode.Range(position, position))];
    }
    // <= (あてはめ)
    if (textBeforeCursor.endsWith('<')) {
      return [new vscode.InlineCompletionItem('=', new vscode.Range(position, position))];
    }
    // >> (効果)
    if (textBeforeCursor.endsWith('>') && !textBeforeCursor.endsWith('>>')) {
      return [new vscode.InlineCompletionItem('>', new vscode.Range(position, position))];
    }
    // :: (論述空間) - 行頭の場合のみ
    if (textBeforeCursor.endsWith(':') && textBeforeCursor.trim() === ':') {
      return [new vscode.InlineCompletionItem(':', new vscode.Range(position, position))];
    }

    // 2. LSPクライアントが起動していない場合は記号ペアのみ
    if (!client || client.state !== 2) { // State.Running = 2
      return null;
    }

    // 3. LSP補完をトリガーする条件をチェック
    const shouldTriggerLSP =
      textBeforeCursor.endsWith('*') ||
      textBeforeCursor.endsWith('＊') ||
      textBeforeCursor.endsWith('%') ||
      textBeforeCursor.endsWith('?') ||
      textBeforeCursor.endsWith('？') ||
      textBeforeCursor.endsWith('$') ||
      textBeforeCursor.endsWith('#');

    if (!shouldTriggerLSP) {
      return null;
    }

    try {
      // LSPサーバーに補完リクエストを送信
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position
      );

      if (!completions || completions.items.length === 0) {
        return null;
      }

      // insertTextを抽出するヘルパー関数
      const getInsertText = (item: vscode.CompletionItem): string => {
        if (typeof item.insertText === 'string') {
          return item.insertText;
        } else if (item.insertText instanceof vscode.SnippetString) {
          return item.insertText.value;
        }
        // insertTextがない場合はlabelを使う
        const label = typeof item.label === 'string' ? item.label : item.label.label;
        // ✓や⚠️を除去してクリーンなテキストを返す
        return label.replace(/^[✓⚠️ ]+/, '');
      };

      // ✓マークが付いていない最初の候補を探す
      const getLabel = (item: vscode.CompletionItem): string => {
        return typeof item.label === 'string' ? item.label : item.label.label;
      };

      let targetItem = completions.items[0];
      const firstLabel = getLabel(targetItem);

      // ✓マークが付いている場合は未記述の候補を優先
      if (firstLabel.startsWith('✓')) {
        const nonWrittenItem = completions.items.find(item => !getLabel(item).startsWith('✓'));
        if (nonWrittenItem) {
          targetItem = nonWrittenItem;
        }
      }

      const insertText = getInsertText(targetItem);
      if (!insertText) {
        return null;
      }

      return [
        new vscode.InlineCompletionItem(
          insertText,
          new vscode.Range(position, position)
        ),
      ];
    } catch (error) {
      console.error('インライン補完エラー:', error);
      return null;
    }
  }
}

export function activate(context: ExtensionContext) {
  // サーバーモジュールのパス
  const serverModule = context.asAbsolutePath(
    path.join('dist', 'lsp', 'server.js')
  );

  // サーバーオプション
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ['--nolazy', '--inspect=6009'],
      },
    },
  };

  // クライアントオプション
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'houjicha' },
      { scheme: 'untitled', language: 'houjicha' },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.{houjicha,hcha}'),
    },
  };

  // クライアントを作成して起動
  client = new LanguageClient(
    'houjichaLanguageServer',
    'ほうじ茶 Language Server',
    serverOptions,
    clientOptions
  );

  client.start();

  // インライン補完プロバイダーを登録
  const inlineProvider = vscode.languages.registerInlineCompletionItemProvider(
    { language: 'houjicha', scheme: 'file' },
    new HoujichaInlineCompletionProvider()
  );

  context.subscriptions.push(inlineProvider);

  // プレビューコマンドを登録
  let currentFormat: RenderFormat = 'structured';

  const previewCommand = vscode.commands.registerCommand('houjicha.openPreview', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'houjicha') {
      vscode.window.showWarningMessage('ほうじ茶ファイルを開いてください');
      return;
    }

    // プレビューパネルを作成または再利用
    if (previewPanel) {
      previewPanel.reveal(vscode.ViewColumn.Two);
    } else {
      previewPanel = vscode.window.createWebviewPanel(
        'houjichaPreview',
        'ほうじ茶 プレビュー',
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      previewPanel.onDidDispose(() => {
        previewPanel = undefined;
      });

      // フォーマット切り替えメッセージを受信
      previewPanel.webview.onDidReceiveMessage((message) => {
        if (message.command === 'switchFormat') {
          currentFormat = message.format as RenderFormat;
          updatePreview(editor.document);
        }
      });
    }

    updatePreview(editor.document);
  });

  // プレビューを更新
  function updatePreview(document: vscode.TextDocument) {
    if (!previewPanel) return;

    try {
      const text = document.getText();
      const { document: ast, errors } = parse(text);

      const content = renderToHtml(ast, { format: currentFormat });
      previewPanel.webview.html = getPreviewHtml(content, currentFormat);
    } catch (error) {
      previewPanel.webview.html = `
        <html>
          <body>
            <h1>エラー</h1>
            <pre>${error}</pre>
          </body>
        </html>
      `;
    }
  }

  // ドキュメント変更時にプレビューを更新
  const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
    if (previewPanel && e.document.languageId === 'houjicha') {
      updatePreview(e.document);
    }
  });

  // アクティブエディタ変更時にプレビューを更新
  const editorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (previewPanel && editor && editor.document.languageId === 'houjicha') {
      updatePreview(editor.document);
    }
  });

  context.subscriptions.push(previewCommand, changeDisposable, editorDisposable);

  // TreeViewを登録
  const treeProvider = new HoujichaTreeProvider();
  const treeView = vscode.window.createTreeView('houjichaOutline', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // ファイル変更時にツリーを更新
  const treeRefreshDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.languageId === 'houjicha') {
      treeProvider.refresh();
    }
  });

  // 新規ファイル作成/削除時にツリーを更新
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{houjicha,hcha}');
  fileWatcher.onDidCreate(() => treeProvider.refresh());
  fileWatcher.onDidDelete(() => treeProvider.refresh());

  // ファイルの特定位置を開くコマンド
  const openLocationCommand = vscode.commands.registerCommand(
    'houjicha.openLocation',
    async (filePath: string, line: number) => {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  );

  // リフレッシュコマンド
  const refreshCommand = vscode.commands.registerCommand('houjicha.refreshOutline', () => {
    treeProvider.refresh();
  });

  // 記号早見表コマンド
  const symbolGuideCommand = vscode.commands.registerCommand('houjicha.showSymbolGuide', () => {
    const panel = vscode.window.createWebviewPanel(
      'houjichaSymbolGuide',
      'ほうじ茶 記号早見表',
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );

    panel.webview.html = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ほうじ茶 記号早見表</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 20px;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        h1 {
            font-size: 1.5em;
            border-bottom: 2px solid var(--vscode-textLink-foreground);
            padding-bottom: 10px;
            margin-bottom: 20px;
        }
        h2 {
            font-size: 1.2em;
            margin-top: 25px;
            margin-bottom: 10px;
            color: var(--vscode-textLink-foreground);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
        }
        th, td {
            padding: 10px 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        th {
            background: var(--vscode-editor-selectionBackground);
            font-weight: 600;
        }
        code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 1.1em;
        }
        .symbol {
            font-size: 1.3em;
            font-weight: bold;
            color: var(--vscode-symbolIcon-functionForeground);
        }
        .shortcut {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 0.85em;
        }
        .description {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <h1>ほうじ茶 記号早見表</h1>

    <h2>基本構文</h2>
    <table>
        <tr>
            <th>記号</th>
            <th>意味</th>
            <th>使用例</th>
        </tr>
        <tr>
            <td class="symbol">#</td>
            <td>主張（罪名・請求原因）</td>
            <td><code>#窃盗罪^刑法235条</code></td>
        </tr>
        <tr>
            <td class="symbol">*</td>
            <td>要件（構成要件）</td>
            <td><code>*他人の財物</code></td>
        </tr>
        <tr>
            <td class="symbol">%</td>
            <td>規範（定義・解釈）</td>
            <td><code>%占有者の意思に反して</code></td>
        </tr>
        <tr>
            <td class="symbol">?</td>
            <td>論点（問題提起）</td>
            <td><code>? 財物の意義</code></td>
        </tr>
        <tr>
            <td class="symbol">&lt;=</td>
            <td>あてはめ（事実の適用）</td>
            <td><code>&lt;= 本件時計は...</code></td>
        </tr>
        <tr>
            <td class="symbol">&gt;&gt;</td>
            <td>効果（最終結論）</td>
            <td><code>&gt;&gt; 甲に窃盗罪が成立</code></td>
        </tr>
    </table>

    <h2>補助記号</h2>
    <table>
        <tr>
            <th>記号</th>
            <th>意味</th>
            <th>使用例</th>
        </tr>
        <tr>
            <td class="symbol">^</td>
            <td>条文参照</td>
            <td><code>^刑法235条</code></td>
        </tr>
        <tr>
            <td class="symbol">::</td>
            <td>論述空間（名前空間）</td>
            <td><code>::甲の罪責</code></td>
        </tr>
        <tr>
            <td class="symbol">~&gt;</td>
            <td>理由（論点内）</td>
            <td><code>~&gt; なぜなら...</code></td>
        </tr>
        <tr>
            <td class="symbol">=&gt;</td>
            <td>帰結（結論の導出）</td>
            <td><code>=&gt; %規範</code></td>
        </tr>
        <tr>
            <td class="symbol">@</td>
            <td>評価（事実の評価）</td>
            <td><code>@悪質 @計画的</code></td>
        </tr>
        <tr>
            <td class="symbol">$</td>
            <td>定数参照</td>
            <td><code>$不法領得</code></td>
        </tr>
    </table>

    <h2>結論・メモ</h2>
    <table>
        <tr>
            <th>記号</th>
            <th>意味</th>
            <th>使用例</th>
        </tr>
        <tr>
            <td class="symbol">+</td>
            <td>該当（要件充足）</td>
            <td><code>+*他人の財物</code></td>
        </tr>
        <tr>
            <td class="symbol">!</td>
            <td>否定（要件不充足）</td>
            <td><code>!*不法領得の意思</code></td>
        </tr>
        <tr>
            <td class="symbol">;</td>
            <td>理由文（論理展開）</td>
            <td><code>; なぜなら〜だから</code></td>
        </tr>
        <tr>
            <td class="symbol">∵</td>
            <td>思考過程メモ</td>
            <td><code>∵ 検討ポイント</code></td>
        </tr>
    </table>

    <h2>キーボードショートカット</h2>
    <table>
        <tr>
            <th>ショートカット</th>
            <th>機能</th>
        </tr>
        <tr>
            <td><span class="shortcut">Ctrl+Shift+V</span></td>
            <td>プレビューを開く</td>
        </tr>
        <tr>
            <td><span class="shortcut">Ctrl+Shift+H</span></td>
            <td>この記号早見表を表示</td>
        </tr>
        <tr>
            <td><span class="shortcut">Ctrl+Space</span></td>
            <td>補完候補を表示</td>
        </tr>
        <tr>
            <td><span class="shortcut">Tab</span></td>
            <td>Ghost補完を確定</td>
        </tr>
    </table>

    <p class="description">
        <strong>Tip:</strong> <code>~</code>, <code>=</code>, <code>&lt;</code>, <code>&gt;</code>, <code>:</code> を入力すると、
        Ghost補完（薄い文字）でペアの記号が表示されます。Tabで確定できます。
    </p>
</body>
</html>
    `;
  });

  context.subscriptions.push(treeView, treeRefreshDisposable, fileWatcher, openLocationCommand, refreshCommand, symbolGuideCommand);
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
