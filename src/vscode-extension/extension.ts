/**
 * ほうじ茶（Houjicha）- VS Code 拡張機能
 * Language Server クライアント
 */

import * as path from 'path';
import { ExtensionContext, workspace } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

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
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
