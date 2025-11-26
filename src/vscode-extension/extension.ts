/**
 * ほうじ茶（Houjicha）- VS Code 拡張機能
 * Language Server クライアント + インライン補完
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

let client: LanguageClient;

// インライン補完プロバイダー
class HoujichaInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
    // LSPクライアントが起動していない場合は何もしない
    if (!client || client.state !== 2) { // State.Running = 2
      return null;
    }

    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    // 補完をトリガーする条件をチェック
    const shouldTrigger =
      textBeforeCursor.endsWith('「') ||
      textBeforeCursor.endsWith('%') ||
      textBeforeCursor.endsWith('?') ||
      textBeforeCursor.endsWith('？') ||
      textBeforeCursor.endsWith('$') ||
      textBeforeCursor.endsWith('#');

    if (!shouldTrigger) {
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

      // 最初の補完候補をインライン補完として表示
      const firstItem = completions.items[0];
      let insertText = '';

      if (typeof firstItem.insertText === 'string') {
        insertText = firstItem.insertText;
      } else if (firstItem.insertText instanceof vscode.SnippetString) {
        insertText = firstItem.insertText.value;
      } else if (firstItem.label) {
        insertText = typeof firstItem.label === 'string' ? firstItem.label : firstItem.label.label;
      }

      if (!insertText) {
        return null;
      }

      // ✓マークが付いている場合は次の候補を使う
      if (insertText.startsWith('✓')) {
        const nonWrittenItem = completions.items.find(item => {
          const label = typeof item.label === 'string' ? item.label : item.label.label;
          return !label.startsWith('✓');
        });
        if (nonWrittenItem) {
          if (typeof nonWrittenItem.insertText === 'string') {
            insertText = nonWrittenItem.insertText;
          } else if (nonWrittenItem.insertText instanceof vscode.SnippetString) {
            insertText = nonWrittenItem.insertText.value;
          } else if (nonWrittenItem.label) {
            insertText = typeof nonWrittenItem.label === 'string' ? nonWrittenItem.label : nonWrittenItem.label.label;
          }
        }
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
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
