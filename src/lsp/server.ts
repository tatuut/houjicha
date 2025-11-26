/**
 * 本件 Matcha - Language Server Protocol サーバー
 * 条文データベース連携、賢い補完、欠落警告対応版
 */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  TextDocumentPositionParams,
  MarkupKind,
  DocumentSymbol,
  SymbolKind,
  FoldingRange,
  FoldingRangeKind,
  SemanticTokensBuilder,
  SemanticTokensLegend,
  SemanticTokens,
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  ExecuteCommandParams,
  TextEdit,
  InsertTextFormat,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { parse, ParseResult } from '../language/parser';
import { Document, Claim, Namespace, Requirement, ASTNode } from '../language/ast';
import {
  ArticleDatabase,
  ArticleData,
  Annotation,
  loadArticleDatabase,
  findArticle,
  generateTemplate,
  getRequiredAnnotations,
  getAllNorms,
  getIssues,
} from '../language/loader';

// 接続を作成
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ドキュメントのパース結果をキャッシュ
const documentCache = new Map<string, ParseResult>();

// 条文データベース（ワークスペースごと）
let articleDatabase: ArticleDatabase = {
  articles: new Map(),
  nameIndex: new Map(),
};

// ワークスペースのルートパス
let workspaceRoot: string | null = null;

// セマンティックトークンの凡例
const tokenTypes = [
  'namespace', 'keyword', 'string', 'function', 'variable',
  'comment', 'operator', 'type', 'parameter',
];

const tokenModifiers = ['declaration', 'definition', 'readonly'];

const legend: SemanticTokensLegend = { tokenTypes, tokenModifiers };

// 初期化
connection.onInitialize((params: InitializeParams): InitializeResult => {
  // ワークスペースのルートを取得
  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    workspaceRoot = URI.parse(params.workspaceFolders[0].uri).fsPath;
  } else if (params.rootUri) {
    workspaceRoot = URI.parse(params.rootUri).fsPath;
  }

  // 条文データベースを読み込み
  if (workspaceRoot) {
    try {
      articleDatabase = loadArticleDatabase(workspaceRoot);
      connection.console.log(`条文データベース読み込み完了: ${articleDatabase.articles.size}件`);
    } catch (e) {
      connection.console.error(`条文データベース読み込みエラー: ${e}`);
    }
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['#', '%', '「', '^', '@', '$', '?', ':', '/'],
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: { legend, full: true },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Source],
      },
      executeCommandProvider: {
        commands: ['matcha.generateTemplate', 'matcha.reloadArticles'],
      },
    },
  };
});

// 初期化完了後
connection.onInitialized(() => {
  connection.console.log('本件 Matcha LSP サーバー起動完了');
});

// コマンド実行
connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  if (params.command === 'matcha.reloadArticles') {
    if (workspaceRoot) {
      articleDatabase = loadArticleDatabase(workspaceRoot);
      connection.console.log(`条文データベース再読み込み: ${articleDatabase.articles.size}件`);
    }
  } else if (params.command === 'matcha.generateTemplate') {
    const [articleQuery, uri] = params.arguments || [];
    if (articleQuery && uri) {
      const article = findArticle(articleDatabase, articleQuery);
      if (article) {
        const template = generateTemplate(article);
        return { template, articleId: article.id };
      }
    }
  }
});

// ドキュメント変更時の処理
documents.onDidChangeContent(change => {
  validateDocument(change.document);
});

// ドキュメントを検証して診断情報を送信
async function validateDocument(textDocument: TextDocument): Promise<void> {
  const text = textDocument.getText();
  const result = parse(text);
  documentCache.set(textDocument.uri, result);

  const diagnostics: Diagnostic[] = result.errors.map(error => ({
    severity: DiagnosticSeverity.Error,
    range: {
      start: { line: error.range.start.line, character: error.range.start.column },
      end: { line: error.range.end.line, character: error.range.end.column },
    },
    message: error.message,
    source: '本件 Matcha',
  }));

  // 意味的な検証（条文データベースを参照）
  diagnostics.push(...validateSemantics(result.document));

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// 意味的な検証
function validateSemantics(doc: Document): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  function checkClaim(claim: Claim): void {
    // 基本チェック：要件がない
    if (claim.requirements.length === 0 && !claim.fact) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: {
          start: { line: claim.range.start.line, character: claim.range.start.column },
          end: { line: claim.range.end.line, character: claim.range.end.column },
        },
        message: '主張に要件または事実のあてはめがありません',
        source: '本件 Matcha',
      });
    }

    // 結論の整合性チェック
    if (claim.concluded === 'positive') {
      const hasNegativeReq = claim.requirements.some(r => r.concluded === 'negative');
      if (hasNegativeReq) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: claim.range.start.line, character: claim.range.start.column },
            end: { line: claim.range.end.line, character: claim.range.end.column },
          },
          message: '主張は該当(+)とされていますが、否定された要件(!)が含まれています',
          source: '本件 Matcha',
        });
      }
    }

    // 条文データベースとの照合：必須要件の欠落チェック
    const article = findArticleForClaim(claim);
    if (article) {
      const requiredAnnotations = getRequiredAnnotations(article);
      const writtenRequirements = new Set<string>();

      // 書かれた要件を収集
      for (const req of claim.requirements) {
        writtenRequirements.add(req.name);
        // 下位要件も収集
        if (req.subRequirements) {
          for (const sub of req.subRequirements) {
            writtenRequirements.add(sub.name);
          }
        }
      }

      // 欠落チェック
      for (const annotation of requiredAnnotations) {
        const reqName = annotation.範囲 || annotation.name || '';
        if (reqName && !writtenRequirements.has(reqName)) {
          // 部分一致もチェック
          const found = Array.from(writtenRequirements).some(w =>
            w.includes(reqName) || reqName.includes(w)
          );
          if (!found) {
            diagnostics.push({
              severity: DiagnosticSeverity.Information,
              range: {
                start: { line: claim.range.start.line, character: claim.range.start.column },
                end: { line: claim.range.end.line, character: claim.range.end.column },
              },
              message: `「${reqName}」の検討が見つかりません`,
              source: '本件 Matcha',
              data: { missingRequirement: reqName, articleId: article.id },
            });
          }
        }
      }

      // 論点の検討漏れチェック
      const issues = getIssues(article);
      for (const { issue } of issues) {
        const hasIssue = claim.requirements.some(req =>
          req.issue?.question?.includes(issue.問題) ||
          req.name.includes(issue.問題)
        );
        if (!hasIssue && issue.問題) {
          diagnostics.push({
            severity: DiagnosticSeverity.Hint,
            range: {
              start: { line: claim.range.start.line, character: claim.range.start.column },
              end: { line: claim.range.end.line, character: claim.range.end.column },
            },
            message: `論点「${issue.問題}」の検討を推奨`,
            source: '本件 Matcha',
          });
        }
      }
    }
  }

  for (const child of doc.children) {
    if (child.type === 'Claim') {
      checkClaim(child);
    } else if (child.type === 'Namespace') {
      for (const nsChild of child.children) {
        if (nsChild.type === 'Claim') {
          checkClaim(nsChild);
        }
      }
    }
  }

  return diagnostics;
}

// 主張から条文を特定
function findArticleForClaim(claim: Claim): ArticleData | undefined {
  // 根拠条文から検索
  if (claim.reference?.citation) {
    const article = findArticle(articleDatabase, claim.reference.citation);
    if (article) return article;
  }

  // 主張名から検索
  return findArticle(articleDatabase, claim.name);
}

// 補完
connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const lineText = text.substring(text.lastIndexOf('\n', offset - 1) + 1, offset);
  const items: CompletionItem[] = [];
  let sortIndex = 0;

  // 補完アイテムにソート順と優先フラグを付与するヘルパー
  const addItem = (item: CompletionItem, preselect = false) => {
    items.push({
      ...item,
      sortText: String(sortIndex++).padStart(5, '0'),  // 00000, 00001, ...
      preselect: preselect && sortIndex === 1,
      filterText: item.label as string,
    });
  };

  // # の後：条文データベースから罪名・法的概念
  if (lineText.endsWith('#') || lineText.match(/#\S*$/)) {
    // データベースから補完
    for (const [id, article] of articleDatabase.articles) {
      addItem({
        label: article.名称 || id,
        kind: CompletionItemKind.Class,
        detail: id,
        documentation: article.原文.substring(0, 100) + '...',
      }, true);
    }
    // フォールバック
    if (items.length === 0) {
      addItem({ label: '窃盗罪', kind: CompletionItemKind.Class, detail: '刑法235条' }, true);
      addItem({ label: '強盗罪', kind: CompletionItemKind.Class, detail: '刑法236条' });
    }
  }

  // ^ の後：条文番号
  if (lineText.endsWith('^') || lineText.match(/\^\S*$/)) {
    for (const id of articleDatabase.articles.keys()) {
      addItem({
        label: id,
        kind: CompletionItemKind.Reference,
        detail: articleDatabase.articles.get(id)?.名称,
      }, true);
    }
  }

  // % の後：規範（条文データベースから）
  if (lineText.endsWith('%') || lineText.match(/%\S*$/)) {
    // 現在の主張を特定して、関連する規範を提案
    const currentClaim = findCurrentClaim(text, offset);
    if (currentClaim) {
      const article = findArticle(articleDatabase, currentClaim);
      if (article) {
        const norms = getAllNorms(article);
        for (const { context, norm } of norms) {
          addItem({
            label: norm.規範,
            kind: CompletionItemKind.Function,
            detail: context,
            documentation: norm.出典 ? `出典: ${norm.出典}` : undefined,
          }, true);
        }
      }
    }
    // フォールバック
    if (items.length === 0) {
      addItem({ label: '事実の認識・認容', kind: CompletionItemKind.Function, detail: '故意' }, true);
    }
  }

  // 「の後：要件名（条文データベースから）
  if (lineText.endsWith('「')) {
    const currentClaim = findCurrentClaim(text, offset);
    if (currentClaim) {
      const article = findArticle(articleDatabase, currentClaim);
      if (article) {
        for (const annotation of article.アノテーション) {
          if (annotation.範囲 && annotation.種別 === '要件') {
            addItem({
              label: annotation.範囲 + '」',
              kind: CompletionItemKind.Property,
              detail: annotation.解釈?.[0]?.規範,
            }, true);
          }
        }
      }
    }
  }

  // ? の後：論点（条文データベースから）
  if (lineText.endsWith('?') || lineText.endsWith('？')) {
    const currentClaim = findCurrentClaim(text, offset);
    if (currentClaim) {
      const article = findArticle(articleDatabase, currentClaim);
      if (article) {
        const issues = getIssues(article);
        for (const { issue } of issues) {
          const norm = issue.解釈[0]?.規範 || '';
          addItem({
            label: ` ${issue.理由 || issue.問題} => %${norm}`,
            kind: CompletionItemKind.Snippet,
            detail: issue.問題,
            insertTextFormat: InsertTextFormat.Snippet,
          }, true);
        }
      }
    }
  }

  // :: の後：論述空間
  if (lineText.endsWith('::') || lineText.endsWith('：：')) {
    addItem({ label: '甲の罪責', kind: CompletionItemKind.Module }, true);
    addItem({ label: '乙の罪責', kind: CompletionItemKind.Module });
    addItem({ label: '設問1', kind: CompletionItemKind.Module });
    addItem({ label: '設問2', kind: CompletionItemKind.Module });
  }

  // /gen: テンプレート生成
  if (lineText.match(/\/gen\s*$/)) {
    for (const [id, article] of articleDatabase.articles) {
      addItem({
        label: `生成: ${article.名称 || id}`,
        kind: CompletionItemKind.Snippet,
        insertText: generateTemplate(article),
        detail: 'テンプレートを生成',
        documentation: article.原文.substring(0, 100),
      }, true);
    }
  }

  // $ の後：定義済み定数
  if (lineText.endsWith('$') || lineText.endsWith('＄')) {
    const cached = documentCache.get(params.textDocument.uri);
    if (cached) {
      for (const [name, def] of cached.document.constants) {
        addItem({
          label: name,
          kind: CompletionItemKind.Constant,
          detail: def.value.content,
        }, true);
      }
    }
  }

  // 行頭での補完
  if (lineText.trim() === '') {
    addItem({ label: '#', kind: CompletionItemKind.Keyword, detail: '主張' }, true);
    addItem({ label: '::', kind: CompletionItemKind.Keyword, detail: '論述空間' });
    addItem({ label: '「', kind: CompletionItemKind.Keyword, detail: '要件' });
    addItem({ label: '%', kind: CompletionItemKind.Keyword, detail: '規範' });
    addItem({ label: '?', kind: CompletionItemKind.Keyword, detail: '論点' });
    addItem({ label: '>>', kind: CompletionItemKind.Keyword, detail: '効果' });
    addItem({ label: '/gen', kind: CompletionItemKind.Keyword, detail: 'テンプレート生成' });
  }

  return items;
});

// 現在の主張を特定
function findCurrentClaim(text: string, offset: number): string | null {
  const beforeCursor = text.substring(0, offset);
  const lines = beforeCursor.split('\n');

  // 後ろから走査して #主張 を探す
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/#([^\^<=:\s]+)/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

// 補完アイテムの詳細
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return item;
});

// ホバー
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const position = params.position;
  const text = document.getText();
  const lines = text.split('\n');
  const line = lines[position.line] || '';

  // 主張名のホバー：条文情報を表示
  const claimMatch = line.match(/#([^\^<=:\s]+)/);
  if (claimMatch) {
    const claimName = claimMatch[1];
    const article = findArticle(articleDatabase, claimName);
    if (article) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `## ${article.名称 || article.id}\n\n### 条文\n\`\`\`\n${article.原文}\`\`\`\n\n### 要件\n${article.アノテーション
            .filter(a => a.種別 === '要件' && a.範囲)
            .map(a => `- 「${a.範囲}」`)
            .join('\n')}`,
        },
      };
    }
  }

  // 根拠条文のホバー
  const refMatch = line.match(/\^([^\s<=:]+)/);
  if (refMatch) {
    const ref = refMatch[1];
    const article = findArticle(articleDatabase, ref);
    if (article) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `## ${article.id}\n\n\`\`\`\n${article.原文}\`\`\``,
        },
      };
    }
  }

  // 記号のホバー情報
  const hoverInfo: { [key: string]: { title: string; description: string } } = {
    '#': { title: '主張（Claim）', description: '法的主張を示します。' },
    '%': { title: '規範（Norm）', description: '法的規範・解釈を示します。' },
    '「': { title: '要件（Requirement）', description: '条文の構成要件を示します。' },
    '?': { title: '論点（Issue）', description: '法的論点を提起します。' },
    '>>': { title: '効果（Effect）', description: '法的効果・結論を示します。' },
    '<=': { title: 'あてはめ（Application）', description: '事実を法的概念にあてはめます。' },
    '@': { title: '評価（Evaluation）', description: '事実に対する法的評価を示します。' },
    '^': { title: '根拠条文（Reference）', description: '根拠となる条文を示します。' },
    '::': { title: '論述空間（Namespace）', description: '答案構成上の分類を示します。' },
    '+': { title: '該当', description: '要件に該当することを示します。' },
    '!': { title: '否定', description: '要件に該当しないことを示します。' },
  };

  for (const [symbol, info] of Object.entries(hoverInfo)) {
    const idx = line.indexOf(symbol);
    if (idx !== -1 && position.character >= idx && position.character <= idx + symbol.length) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `## ${info.title}\n\n${info.description}`,
        },
      };
    }
  }

  return null;
});

// コードアクション
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const actions: CodeAction[] = [];
  const document = documents.get(params.textDocument.uri);
  if (!document) return actions;

  for (const diagnostic of params.context.diagnostics) {
    // 欠落要件の追加アクション
    if (diagnostic.data?.missingRequirement) {
      const reqName = diagnostic.data.missingRequirement;
      const articleId = diagnostic.data.articleId;
      const article = articleDatabase.articles.get(articleId);

      if (article) {
        const annotation = article.アノテーション.find(
          (a: Annotation) => a.範囲 === reqName || a.name === reqName
        );
        const norm = annotation?.解釈?.[0]?.規範;
        const insertText = norm
          ? `    「${reqName}」: %${norm} <= 【あてはめ】\n`
          : `    「${reqName}」 <= 【あてはめ】\n`;

        actions.push({
          title: `「${reqName}」を追加`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [params.textDocument.uri]: [{
                range: {
                  start: { line: diagnostic.range.end.line, character: 0 },
                  end: { line: diagnostic.range.end.line, character: 0 },
                },
                newText: insertText,
              }],
            },
          },
        });
      }
    }
  }

  return actions;
});

// ドキュメントシンボル
connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const cached = documentCache.get(params.textDocument.uri);
  if (!cached) return [];

  const symbols: DocumentSymbol[] = [];

  function createSymbol(
    name: string,
    kind: SymbolKind,
    range: { start: { line: number; column: number }; end: { line: number; column: number } },
    children?: DocumentSymbol[]
  ): DocumentSymbol {
    return {
      name,
      kind,
      range: {
        start: { line: range.start.line, character: range.start.column },
        end: { line: range.end.line, character: range.end.column },
      },
      selectionRange: {
        start: { line: range.start.line, character: range.start.column },
        end: { line: range.end.line, character: range.end.column },
      },
      children,
    };
  }

  function processRequirements(requirements: Requirement[]): DocumentSymbol[] {
    return requirements.map(req => {
      const children: DocumentSymbol[] = [];
      if (req.subRequirements) {
        children.push(...processRequirements(req.subRequirements));
      }
      return createSymbol(req.name, SymbolKind.Property, req.range, children.length > 0 ? children : undefined);
    });
  }

  function processClaim(claim: Claim): DocumentSymbol {
    const prefix = claim.concluded === 'positive' ? '+' : claim.concluded === 'negative' ? '!' : '';
    const children = processRequirements(claim.requirements);
    if (claim.effect) {
      children.push(createSymbol(claim.effect.content, SymbolKind.Event, claim.effect.range));
    }
    return createSymbol(`${prefix}#${claim.name}`, SymbolKind.Class, claim.range, children.length > 0 ? children : undefined);
  }

  for (const child of cached.document.children) {
    if (child.type === 'Namespace') {
      const nsChildren: DocumentSymbol[] = [];
      for (const nsChild of child.children) {
        if (nsChild.type === 'Claim') {
          nsChildren.push(processClaim(nsChild));
        }
      }
      symbols.push(createSymbol(`::${child.name}`, SymbolKind.Namespace, child.range, nsChildren.length > 0 ? nsChildren : undefined));
    } else if (child.type === 'Claim') {
      symbols.push(processClaim(child));
    }
  }

  return symbols;
});

// フォールディング範囲
connection.onFoldingRanges((params): FoldingRange[] => {
  const cached = documentCache.get(params.textDocument.uri);
  if (!cached) return [];

  const ranges: FoldingRange[] = [];

  function addRange(node: ASTNode): void {
    if (node.range.end.line > node.range.start.line) {
      ranges.push({
        startLine: node.range.start.line,
        endLine: node.range.end.line,
        kind: FoldingRangeKind.Region,
      });
    }
  }

  for (const child of cached.document.children) {
    addRange(child);
    if (child.type === 'Namespace') {
      for (const nsChild of child.children) {
        addRange(nsChild);
      }
    } else if (child.type === 'Claim') {
      for (const req of child.requirements) {
        addRange(req);
      }
    }
  }

  return ranges;
});

// セマンティックトークン
connection.languages.semanticTokens.on((params): SemanticTokens => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };

  const builder = new SemanticTokensBuilder();
  const text = document.getText();
  const lines = text.split('\n');

  lines.forEach((line, lineIndex) => {
    let match: RegExpExecArray | null;

    if ((match = /^(\s*)(::)(.*)/.exec(line))) {
      builder.push(lineIndex, match[1].length, 2, tokenTypes.indexOf('keyword'), 0);
      builder.push(lineIndex, match[1].length + 2, match[3].length, tokenTypes.indexOf('namespace'), 0);
    }
    if ((match = /\/\/(.*)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('comment'), 0);
    }
    if ((match = /([+!]?)#([^\\^<=:]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('keyword'), 0);
    }
    if ((match = /\^([^<=:\s]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('type'), 0);
    }
    if ((match = /「([^」]+)」/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('string'), 0);
    }
    if ((match = /([+!]?)%([^<=:\s@]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('function'), 0);
    }
    if ((match = /@([^\s&|)]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('parameter'), 0);
    }
    if ((match = /\$([^\s<=:]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('variable'), 0);
    }
  });

  return builder.build();
});

// ドキュメントマネージャーと接続を開始
documents.listen(connection);
connection.listen();
