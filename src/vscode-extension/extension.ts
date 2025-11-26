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
      textBeforeCursor.endsWith('*') ||
      textBeforeCursor.endsWith('＊') ||
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

      // insertTextを抽出するヘルパー関数
      const getInsertText = (item: vscode.CompletionItem): string => {
        if (typeof item.insertText === 'string') {
          return item.insertText;
        } else if (item.insertText instanceof vscode.SnippetString) {
          return item.insertText.value;
        }
        // insertTextがない場合はlabelを使うが、「」マーカーを除去
        const label = typeof item.label === 'string' ? item.label : item.label.label;
        // ✓や「」を除去してクリーンなテキストを返す
        return label.replace(/^[✓ ]+/, '').replace(/^「/, '').replace(/」$/, '') + '」 <= ';
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
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
