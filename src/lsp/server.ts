/**
 * Chai - Language Server Protocol サーバー
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
  Definition,
  Location,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import * as fs from 'fs';
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
        triggerCharacters: ['#', '%', '*', '^', '@', '$', '?', ':', '/'],
      },
      hoverProvider: true,
      definitionProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: { legend, full: true },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Source],
      },
      executeCommandProvider: {
        commands: ['chai.generateTemplate', 'chai.reloadArticles'],
      },
    },
  };
});

// 初期化完了後
connection.onInitialized(() => {
  connection.console.log('Chai LSP サーバー起動完了');
});

// コマンド実行
connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  if (params.command === 'chai.reloadArticles') {
    if (workspaceRoot) {
      articleDatabase = loadArticleDatabase(workspaceRoot);
      connection.console.log(`条文データベース再読み込み: ${articleDatabase.articles.size}件`);
    }
  } else if (params.command === 'chai.generateTemplate') {
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
  // DBが空なら、ドキュメントの場所から読み込みを試みる
  if (articleDatabase.articles.size === 0) {
    tryLoadDatabaseFromDocument(change.document);
  }
  validateDocument(change.document);
});

// ドキュメントの場所から条文データベースを探して読み込む
function tryLoadDatabaseFromDocument(doc: TextDocument): void {
  try {
    const docPath = URI.parse(doc.uri).fsPath;
    let currentDir = path.dirname(docPath);

    // 親ディレクトリを最大5階層まで探索
    for (let i = 0; i < 5; i++) {
      const articlesDir = path.join(currentDir, 'articles');
      if (fs.existsSync(articlesDir)) {
        articleDatabase = loadArticleDatabase(currentDir);
        connection.console.log(`[自動検出] 条文DB読み込み: ${currentDir} (${articleDatabase.articles.size}件)`);
        return;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break; // ルートに到達
      currentDir = parentDir;
    }

    connection.console.log(`[自動検出] articlesフォルダが見つかりません`);
  } catch (e) {
    connection.console.error(`[自動検出] エラー: ${e}`);
  }
}

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
    source: 'Chai',
  }));

  // 全角スペースの警告
  diagnostics.push(...detectFullWidthSpaces(text));

  // 意味的な検証（条文データベースを参照）
  diagnostics.push(...validateSemantics(result.document));

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// 全角スペースを検出して警告
function detectFullWidthSpaces(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = text.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    let col = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\u3000') {  // 全角スペース
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: lineNum, character: col },
            end: { line: lineNum, character: col + 1 },
          },
          message: '全角スペースが使用されています。半角スペースに置き換えてください。',
          source: 'Chai',
          data: { type: 'fullWidthSpace' },
        });
      }
      col++;
    }
  }

  return diagnostics;
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
        source: 'Chai',
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
          source: 'Chai',
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
              source: 'Chai',
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
            source: 'Chai',
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

  // 補完時にもDBが空なら読み込みを試みる
  if (articleDatabase.articles.size === 0) {
    connection.console.log('[補完] DB空のため再読み込み試行');
    tryLoadDatabaseFromDocument(document);
  }

  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const lineText = text.substring(text.lastIndexOf('\n', offset - 1) + 1, offset);
  const items: CompletionItem[] = [];

  connection.console.log(`[補完開始] offset=${offset}, lineText="${lineText}", DB=${articleDatabase.articles.size}件`);

  // # の後：条文データベースから罪名・法的概念
  if (lineText.endsWith('#') || lineText.match(/#\S*$/)) {
    // データベースから補完
    for (const [id, article] of articleDatabase.articles) {
      items.push({
        label: article.名称 || id,
        kind: CompletionItemKind.Class,
        detail: id,
        documentation: article.原文.substring(0, 100) + '...',
      });
    }
    // フォールバック
    if (items.length === 0) {
      items.push(
        { label: '窃盗罪', kind: CompletionItemKind.Class, detail: '刑法235条' },
        { label: '強盗罪', kind: CompletionItemKind.Class, detail: '刑法236条' },
      );
    }
  }

  // ^ の後：条文番号
  if (lineText.endsWith('^') || lineText.match(/\^\S*$/)) {
    for (const id of articleDatabase.articles.keys()) {
      items.push({
        label: id,
        kind: CompletionItemKind.Reference,
        detail: articleDatabase.articles.get(id)?.名称,
      });
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
          // Markdown形式の詳細説明を構築
          let docContent = `### ${norm.規範}\n\n`;
          if (norm.出典) {
            docContent += `**出典**: ${norm.出典}\n\n`;
          }
          if (norm.説明) {
            docContent += `${norm.説明}\n\n`;
          }
          docContent += `**文脈**: ${context}`;

          items.push({
            label: norm.規範,
            kind: CompletionItemKind.Function,
            detail: `${context}${norm.出典 ? ` (${norm.出典})` : ''}`,
            documentation: {
              kind: MarkupKind.Markdown,
              value: docContent,
            },
          });
        }
      }
    }
    // フォールバック
    if (items.length === 0) {
      items.push(
        { label: '事実の認識・認容', kind: CompletionItemKind.Function, detail: '故意' },
      );
    }
  }

  // * の後：要件名（条文データベースから、条文順でソート）
  // * は閉じ括弧不要のシンプルな要件マーカー
  const hasAsterisk = lineText.endsWith('*') || lineText.endsWith('＊');

  connection.console.log(`[補完デバッグ] lineText="${lineText}", hasAsterisk=${hasAsterisk}`);

  if (hasAsterisk) {
    const currentClaim = findCurrentClaim(text, offset);
    connection.console.log(`[補完] 現在の主張: ${currentClaim}, DB件数: ${articleDatabase.articles.size}`);

    if (currentClaim) {
      const article = findArticle(articleDatabase, currentClaim);
      connection.console.log(`[補完] 条文検索結果: ${article ? article.id : 'なし'}`);

      if (article) {
        // 既に書かれている要件を収集
        const cached = documentCache.get(params.textDocument.uri);
        const writtenReqs = new Set<string>();
        if (cached) {
          for (const child of cached.document.children) {
            if (child.type === 'Claim') {
              for (const req of child.requirements) {
                writtenReqs.add(req.name);
              }
            }
          }
        }

        let sortOrder = 0;
        for (const annotation of article.アノテーション) {
          // 範囲があるか、nameがある要件をすべて補完候補に
          const reqName = annotation.範囲 || annotation.name;
          if (reqName && (annotation.種別 === '要件' || annotation.種別 === '論点')) {
            sortOrder++;
            const isWritten = writtenReqs.has(reqName);

            // Markdown形式の詳細説明を構築
            let docContent = isWritten
              ? `## ✓ *${reqName}*（記述済み）\n\n`
              : `## *${reqName}*\n\n`;

            // 種別を表示
            if (annotation.種別 === '論点') {
              docContent += `**論点（不文の要件）**\n\n`;
              if (annotation.理由) {
                docContent += `_${annotation.理由}_\n\n`;
              }
            }

            // 規範
            if (annotation.解釈 && annotation.解釈.length > 0) {
              docContent += `### 規範\n`;
              for (const interp of annotation.解釈) {
                docContent += `- **${interp.規範}**`;
                if (interp.出典) docContent += ` (${interp.出典})`;
                docContent += '\n';
                if (interp.説明) docContent += `  - ${interp.説明}\n`;
              }
              docContent += '\n';
            }

            // 下位要件
            if (annotation.下位要件 && annotation.下位要件.length > 0) {
              docContent += `### 下位要件\n`;
              for (const sub of annotation.下位要件) {
                docContent += `- **${sub.name}**`;
                if (sub.規範) docContent += `: ${sub.規範}`;
                docContent += '\n';
              }
              docContent += '\n';
            }

            // 関連論点
            if (annotation.論点 && annotation.論点.length > 0) {
              docContent += `### 関連論点\n`;
              for (const issue of annotation.論点) {
                docContent += `- **${issue.問題}**`;
                if (issue.理由) docContent += `: ${issue.理由}`;
                docContent += '\n';
              }
            }

            // 段階的補完: 要件名だけを挿入（規範やあてはめは後で）
            const norm = annotation.解釈?.[0]?.規範;
            items.push({
              label: (isWritten ? '✓ ' : '') + reqName,
              kind: CompletionItemKind.Property,
              detail: norm || annotation.種別,
              documentation: {
                kind: MarkupKind.Markdown,
                value: docContent,
              },
              sortText: `${isWritten ? '1' : '0'}-${String(sortOrder).padStart(2, '0')}`,
              filterText: '*' + reqName,
              // 要件名だけ挿入（次のステップで : や % を入力）
              insertText: reqName,
              insertTextFormat: InsertTextFormat.PlainText,
            });
          }
        }
        connection.console.log(`[補完] ${items.length}件の要件候補を生成`);
      } else {
        // 条文が見つからない場合のフォールバック
        connection.console.log(`[補完] フォールバック: 条文未発見 (主張=${currentClaim})`);
        items.push(
          { label: '要件名', kind: CompletionItemKind.Property, detail: '要件を追加', insertText: '要件名 <= ' },
        );
      }
    } else {
      // 主張が見つからない場合
      connection.console.log(`[補完] フォールバック: 主張未発見`);
      items.push(
        { label: '要件名', kind: CompletionItemKind.Property, detail: '要件を追加', insertText: '要件名 <= ' },
      );
    }

    // DBが空の場合の警告
    if (articleDatabase.articles.size === 0) {
      items.push({
        label: '⚠️ 条文DBが読み込まれていません',
        kind: CompletionItemKind.Text,
        detail: 'フォルダを開き直してください',
        documentation: 'VSCodeで「ファイル」→「フォルダを開く」でmachaフォルダを開いてください。',
      });
    }
  }

  // ? の後：論点（条文データベースから、未検討を優先）
  if (lineText.endsWith('?') || lineText.endsWith('？')) {
    const currentClaim = findCurrentClaim(text, offset);
    if (currentClaim) {
      const article = findArticle(articleDatabase, currentClaim);
      if (article) {
        // 既に書かれている論点を収集
        const cached = documentCache.get(params.textDocument.uri);
        const writtenIssues = new Set<string>();
        if (cached) {
          for (const child of cached.document.children) {
            if (child.type === 'Claim') {
              for (const req of child.requirements) {
                if (req.issue?.question) {
                  writtenIssues.add(req.issue.question);
                }
              }
            }
          }
        }

        const issues = getIssues(article);
        let sortOrder = 0;
        for (const { annotation, issue } of issues) {
          sortOrder++;
          const norm = issue.解釈[0]?.規範 || '';
          const isWritten = writtenIssues.has(issue.問題);

          // Markdown形式の詳細説明を構築
          let docContent = isWritten
            ? `## ✓ 論点: ${issue.問題}（検討済み）\n\n`
            : `## ⚠️ 論点: ${issue.問題}（未検討）\n\n`;
          if (issue.理由) {
            docContent += `**問題の所在**: ${issue.理由}\n\n`;
          }
          if (annotation.範囲) {
            docContent += `**関連要件**: 「${annotation.範囲}」\n\n`;
          }

          docContent += `### 学説・判例\n`;
          for (const interp of issue.解釈) {
            docContent += `- **${interp.規範}**`;
            if (interp.出典) docContent += ` (${interp.出典})`;
            docContent += '\n';
            if (interp.説明) docContent += `  - ${interp.説明}\n`;
          }

          // 段階的補完: 論点名だけを挿入（~> 理由 => %規範 は後で）
          items.push({
            label: (isWritten ? '✓ ' : '⚠️ ') + issue.問題,
            kind: CompletionItemKind.Snippet,
            detail: isWritten ? `✓ 検討済み` : `⚠️ 未検討`,
            documentation: {
              kind: MarkupKind.Markdown,
              value: docContent,
            },
            // 未検討を上位に
            sortText: `${isWritten ? '1' : '0'}-${String(sortOrder).padStart(2, '0')}`,
            // 論点名だけ挿入（次のステップで ~> を入力）
            insertText: ` ${issue.問題}`,
            insertTextFormat: InsertTextFormat.PlainText,
          });
        }
      }
    }
  }

  // :: の後：論述空間
  if (lineText.endsWith('::') || lineText.endsWith('：：')) {
    items.push(
      { label: '甲の罪責', kind: CompletionItemKind.Module },
      { label: '乙の罪責', kind: CompletionItemKind.Module },
      { label: '設問1', kind: CompletionItemKind.Module },
      { label: '設問2', kind: CompletionItemKind.Module },
    );
  }

  // /gen: テンプレート生成
  if (lineText.match(/\/gen/) || lineText.trimStart().startsWith('/')) {
    // /gen の開始位置を特定
    const genMatch = lineText.match(/\/gen\S*/);
    const genStart = genMatch ? lineText.indexOf(genMatch[0]) : lineText.lastIndexOf('/');
    const genEnd = genMatch ? genStart + genMatch[0].length : lineText.length;

    for (const [id, article] of articleDatabase.articles) {
      items.push({
        label: `生成: ${article.名称 || id}`,
        kind: CompletionItemKind.Snippet,
        detail: 'テンプレートを生成',
        documentation: {
          kind: MarkupKind.Markdown,
          value: `**${article.名称 || id}**\n\n${article.原文.substring(0, 150)}...`,
        },
        // /gen を置換してテンプレートを挿入
        textEdit: {
          range: {
            start: { line: params.position.line, character: genStart },
            end: { line: params.position.line, character: genEnd },
          },
          newText: generateTemplate(article),
        },
        filterText: '/gen ' + (article.名称 || id),
      });
    }
  }

  // $ の後：定義済み定数
  if (lineText.endsWith('$') || lineText.endsWith('＄')) {
    const cached = documentCache.get(params.textDocument.uri);
    if (cached) {
      for (const [name, def] of cached.document.constants) {
        items.push({
          label: name,
          kind: CompletionItemKind.Constant,
          detail: def.value.content,
        });
      }
    }
  }

  // 記号ガイド補完（何も入力していない状態）
  const trimmedLine = lineText.trim();
  const isInsideClaim = findCurrentClaim(text, offset) !== null;
  const isIndented = lineText.length > 0 && lineText.length !== trimmedLine.length;

  if (trimmedLine === '' && items.length === 0) {
    if (isIndented && isInsideClaim) {
      // 主張内（インデント）：使える記号を表示
      items.push(
        {
          label: '*',
          kind: CompletionItemKind.Keyword,
          detail: '要件',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## *要件*\n\n条文の構成要件を記述します。\n\n```\n*他人の財物: %規範 <= あてはめ\n```',
          },
          sortText: '01',
        },
        {
          label: '%',
          kind: CompletionItemKind.Keyword,
          detail: '規範',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## %規範\n\n法的規範・解釈を記述します。\n\n```\n%占有者の意思に反して占有を移転\n```',
          },
          sortText: '02',
        },
        {
          label: '?',
          kind: CompletionItemKind.Keyword,
          detail: '論点',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## ?論点\n\n法的論点を提起します。\n\n```\n? 財物の意義 ~> 理由 => %規範\n```',
          },
          sortText: '03',
        },
        {
          label: '$',
          kind: CompletionItemKind.Keyword,
          detail: '定数参照',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## $定数\n\n定義済みの規範を参照します。\n\n```\n$不法領得 <= あてはめ\n```',
          },
          sortText: '04',
        },
        {
          label: ';',
          kind: CompletionItemKind.Keyword,
          detail: '理由',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## ;理由\n\n独立した理由文を記述します。\n\n```\n; なぜなら〜だからである\n```',
          },
          sortText: '05',
        },
        {
          label: '∵',
          kind: CompletionItemKind.Keyword,
          detail: '思考過程メモ',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## ∵思考過程メモ\n\n自分の思考過程をメモします。プレビューには表示されません。\n\n```\n∵ ここは自分の考えを整理するためのメモ\n```',
          },
          sortText: '05b',
        },
        {
          label: '+',
          kind: CompletionItemKind.Keyword,
          detail: '該当',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## +該当\n\n要件に該当することを明示します。\n\n```\n+*他人の財物 <= 充足\n```',
          },
          sortText: '06',
        },
        {
          label: '!',
          kind: CompletionItemKind.Keyword,
          detail: '否定',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## !否定\n\n要件に該当しないことを明示します。\n\n```\n!*不法領得の意思 <= 欠如\n```',
          },
          sortText: '07',
        },
      );
    } else {
      // トップレベル：主張や論述空間
      items.push(
        {
          label: '#',
          kind: CompletionItemKind.Keyword,
          detail: '主張',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## #主張\n\n法的主張を開始します。\n\n```\n#窃盗罪^刑法235条 <= 甲の行為:\n```',
          },
          sortText: '01',
        },
        {
          label: '::',
          kind: CompletionItemKind.Keyword,
          detail: '論述空間',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## ::論述空間\n\n答案の区切りを作ります。\n\n```\n::甲の罪責\n::乙の罪責\n```',
          },
          sortText: '02',
        },
        {
          label: '/gen',
          kind: CompletionItemKind.Keyword,
          detail: 'テンプレート生成',
          documentation: {
            kind: MarkupKind.Markdown,
            value: '## /gen\n\n条文からテンプレートを自動生成します。',
          },
          sortText: '03',
        },
      );
    }

    // 記号早見表を追加
    items.push({
      label: '📖 記号早見表',
      kind: CompletionItemKind.Text,
      detail: '記号の一覧と使い方',
      documentation: {
        kind: MarkupKind.Markdown,
        value: `## 記号早見表

| 記号 | 意味 | 使用例 |
|------|------|--------|
| \`#\` | 主張 | \`#窃盗罪^刑法235条\` |
| \`*\` | 要件 | \`*他人の財物\` |
| \`%\` | 規範 | \`%占有者の意思に反して\` |
| \`?\` | 論点 | \`? 財物の意義\` |
| \`>>\` | 効果 | \`>> 甲に窃盗罪が成立\` |
| \`<=\` | あてはめ | \`<= 本件時計は...\` |
| \`~>\` | 理由 | \`~> なぜなら...\` |
| \`::\` | 論述空間 | \`::甲の罪責\` |
| \`^\` | 条文参照 | \`^刑法235条\` |
| \`$\` | 定数参照 | \`$不法領得\` |
| \`@\` | 評価 | \`@悪質\` |
| \`+\` | 該当 | \`+*要件\` |
| \`!\` | 否定 | \`!*要件\` |
| \`;\` | 理由文 | \`; なぜなら...\` |
| \`∵\` | 思考メモ | \`∵ 検討メモ\` |
`,
      },
      sortText: '99',
    });
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

  // カーソル位置の前後を取得して、より正確なコンテキストを把握
  const currentClaim = findCurrentClaim(text, document.offsetAt(position));

  // 要件 *要件名 のホバー：詳細情報を表示（上位文脈付き）
  const asteriskReqMatch = line.match(/\*([^\s:<=]+)/);
  if (asteriskReqMatch) {
    const reqName = asteriskReqMatch[1];
    const reqIndex = line.indexOf(asteriskReqMatch[0]);
    // カーソルが要件名の上にあるか確認
    if (position.character >= reqIndex && position.character <= reqIndex + asteriskReqMatch[0].length) {
      const article = currentClaim ? findArticle(articleDatabase, currentClaim) : null;
      if (article) {
        const annotation = article.アノテーション.find(
          a => a.範囲 === reqName || a.name === reqName
        );
        if (annotation) {
          // 上位文脈を表示
          let content = currentClaim
            ? `## ${currentClaim} > *${reqName}*\n\n`
            : `## *${reqName}*\n\n`;

          // 規範
          if (annotation.解釈 && annotation.解釈.length > 0) {
            content += `### 規範\n`;
            for (const interp of annotation.解釈) {
              content += `- **${interp.規範}**`;
              if (interp.出典) content += ` _(${interp.出典})_`;
              content += '\n';
              if (interp.説明) content += `  > ${interp.説明}\n`;
            }
            content += '\n';
          }

          // 下位要件
          if (annotation.下位要件 && annotation.下位要件.length > 0) {
            content += `### 下位要件\n`;
            for (const sub of annotation.下位要件) {
              content += `- **${sub.name}**`;
              if (sub.規範) content += `: ${sub.規範}`;
              content += '\n';
            }
            content += '\n';
          }

          // 論点
          if (annotation.論点 && annotation.論点.length > 0) {
            content += `### 関連論点\n`;
            for (const issue of annotation.論点) {
              content += `#### ${issue.問題}\n`;
              if (issue.理由) content += `_${issue.理由}_\n\n`;
              for (const interp of issue.解釈) {
                content += `- ${interp.規範}`;
                if (interp.出典) content += ` _(${interp.出典})_`;
                content += '\n';
              }
            }
          }

          return { contents: { kind: MarkupKind.Markdown, value: content } };
        }
      }
    }
  }

  // 規範%のホバー：詳細情報を表示（上位文脈付き）
  const normMatch = line.match(/%([^\s<=:@]+)/);
  if (normMatch) {
    const normText = normMatch[1];
    const normIndex = line.indexOf(normMatch[0]);
    if (position.character >= normIndex && position.character <= normIndex + normMatch[0].length) {
      const article = currentClaim ? findArticle(articleDatabase, currentClaim) : null;
      if (article) {
        const norms = getAllNorms(article);
        const found = norms.find(n => n.norm.規範.includes(normText) || normText.includes(n.norm.規範));
        if (found) {
          let content = `## 規範\n\n`;
          content += `**${found.norm.規範}**\n\n`;
          if (found.norm.出典) content += `**出典**: ${found.norm.出典}\n\n`;
          if (found.norm.説明) content += `${found.norm.説明}\n\n`;
          // 上位文脈を表示（主張名 > 要件文脈）
          if (currentClaim) {
            content += `**上位文脈**: ${currentClaim} > ${found.context}`;
          } else {
            content += `**文脈**: ${found.context}`;
          }
          return { contents: { kind: MarkupKind.Markdown, value: content } };
        }
      }
    }
  }

  // 主張名のホバー：条文情報を表示
  const claimMatch = line.match(/#([^\^<=:\s]+)/);
  if (claimMatch) {
    const claimName = claimMatch[1];
    const claimIndex = line.indexOf(claimMatch[0]);
    if (position.character >= claimIndex && position.character <= claimIndex + claimMatch[0].length) {
      const article = findArticle(articleDatabase, claimName);
      if (article) {
        let content = `## ${article.名称 || article.id}\n\n`;
        content += `### 条文\n\`\`\`\n${article.原文}\`\`\`\n\n`;

        content += `### 要件\n`;
        for (const a of article.アノテーション.filter(a => a.種別 === '要件')) {
          const name = a.範囲 || a.name || '';
          content += `- **「${name}」**`;
          if (a.解釈?.[0]?.規範) content += `: ${a.解釈[0].規範}`;
          content += '\n';
        }

        // 論点
        const issues = getIssues(article);
        if (issues.length > 0) {
          content += `\n### 論点\n`;
          for (const { issue } of issues) {
            content += `- **${issue.問題}**`;
            if (issue.理由) content += `: ${issue.理由}`;
            content += '\n';
          }
        }

        return { contents: { kind: MarkupKind.Markdown, value: content } };
      }
    }
  }

  // 根拠条文のホバー
  const refMatch = line.match(/\^([^\s<=:]+)/);
  if (refMatch) {
    const ref = refMatch[1];
    const refIndex = line.indexOf(refMatch[0]);
    if (position.character >= refIndex && position.character <= refIndex + refMatch[0].length) {
      const article = findArticle(articleDatabase, ref);
      if (article) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `## ${article.id}（${article.名称 || ''}）\n\n\`\`\`\n${article.原文}\`\`\``,
          },
        };
      }
    }
  }

  // $定数参照のホバー：定義内容を表示
  const constMatch = line.match(/\$([^\s<=:]+)/);
  if (constMatch) {
    const constName = constMatch[1];
    const constIndex = line.indexOf(constMatch[0]);
    if (position.character >= constIndex && position.character <= constIndex + constMatch[0].length) {
      const cached = documentCache.get(params.textDocument.uri);
      if (cached) {
        const constDef = cached.document.constants.get(constName);
        if (constDef) {
          let content = `## 定数: ${constName}\n\n`;
          content += `### 規範\n\`\`\`\n${constDef.value.content}\n\`\`\`\n\n`;
          if (constDef.value.reference) {
            content += `**根拠条文**: ${constDef.value.reference.citation}\n\n`;
          }
          content += `**定義位置**: ${constDef.range.start.line + 1}行目`;
          return { contents: { kind: MarkupKind.Markdown, value: content } };
        } else {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `## ⚠️ 未定義の定数\n\n\`${constName}\` は定義されていません。\n\n\`as ${constName}\` で定義してください。`,
            },
          };
        }
      }
    }
  }

  // 記号のホバー情報
  const hoverInfo: { [key: string]: { title: string; description: string } } = {
    '#': { title: '主張（Claim）', description: '法的主張を示します。' },
    '%': { title: '規範（Norm）', description: '法的規範・解釈を示します。' },
    '*': { title: '要件（Requirement）', description: '条文の構成要件を示します。' },
    '?': { title: '論点（Issue）', description: '法的論点を提起します。' },
    '>>': { title: '効果（Effect）', description: '法的効果・結論を示します。' },
    '<=': { title: 'あてはめ（Application）', description: '事実を法的概念にあてはめます。' },
    '@': { title: '評価（Evaluation）', description: '事実に対する法的評価を示します。' },
    '^': { title: '根拠条文（Reference）', description: '根拠となる条文を示します。' },
    '::': { title: '論述空間（Namespace）', description: '答案構成上の分類を示します。' },
    '+': { title: '該当', description: '要件に該当することを示します。' },
    '!': { title: '否定', description: '要件に該当しないことを示します。' },
    '∵': { title: '思考過程メモ（ThinkingMemo）', description: '自分の思考過程をメモします。プレビューには表示されません。' },
    ';': { title: '理由文（ReasonStatement）', description: '独立した理由文を記述します。' },
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

// Go to Definition（$定数の定義元へジャンプ）
connection.onDefinition((params: TextDocumentPositionParams): Definition | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const position = params.position;
  const text = document.getText();
  const lines = text.split('\n');
  const line = lines[position.line] || '';

  // $定数参照の定義元を探す
  const constMatch = line.match(/\$([^\s<=:]+)/);
  if (constMatch) {
    const constName = constMatch[1];
    const constIndex = line.indexOf(constMatch[0]);
    if (position.character >= constIndex && position.character <= constIndex + constMatch[0].length) {
      const cached = documentCache.get(params.textDocument.uri);
      if (cached) {
        const constDef = cached.document.constants.get(constName);
        if (constDef) {
          return Location.create(params.textDocument.uri, {
            start: { line: constDef.range.start.line, character: constDef.range.start.column },
            end: { line: constDef.range.end.line, character: constDef.range.end.column },
          });
        }
      }
    }
  }

  // as 定数名 の定義元（定義自体）
  const asMatch = line.match(/as\s+([^\s<=]+)/);
  if (asMatch) {
    const constName = asMatch[1];
    const asIndex = line.indexOf(asMatch[0]);
    if (position.character >= asIndex && position.character <= asIndex + asMatch[0].length) {
      // 定義自体なので、この行を返す
      return Location.create(params.textDocument.uri, {
        start: { line: position.line, character: asIndex },
        end: { line: position.line, character: asIndex + asMatch[0].length },
      });
    }
  }

  return null;
});

// コードアクション
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const actions: CodeAction[] = [];
  const document = documents.get(params.textDocument.uri);
  if (!document) return actions;

  const text = document.getText();
  const lines = text.split('\n');

  for (const diagnostic of params.context.diagnostics) {
    const diagLine = diagnostic.range.start.line;
    const lineText = lines[diagLine] || '';

    // 1. 欠落要件の追加アクション
    if (diagnostic.data?.missingRequirement) {
      const reqName = diagnostic.data.missingRequirement;
      const articleId = diagnostic.data.articleId;
      const article = articleDatabase.articles.get(articleId);

      if (article) {
        const annotation = article.アノテーション.find(
          (a: Annotation) => a.範囲 === reqName || a.name === reqName
        );
        const norm = annotation?.解釈?.[0]?.規範;

        // 挿入位置を探す（主張の最後の要件の後、または効果の前）
        let insertLine = diagnostic.range.end.line;
        for (let i = diagLine + 1; i < lines.length; i++) {
          const l = lines[i];
          // 次の主張、名前空間、効果、トップレベルコメント、空行が来たら終了
          if (l.match(/^\s*#/) || l.match(/^\s*::/) || l.match(/^\s*>>/) ||
              l.match(/^\/\//) || l.trim() === '') {
            insertLine = i;
            break;
          }
          // インデントされた要件行があれば更新
          if (l.match(/^\s+\*/) || l.match(/^\s+%/) || l.match(/^\s+;/) || l.match(/^\s+\?/)) {
            insertLine = i + 1;
          }
        }

        const insertText = norm
          ? `    *${reqName}: %${norm} <= 【あてはめ】\n`
          : `    *${reqName} <= 【あてはめ】\n`;

        actions.push({
          title: `*${reqName}を追加`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: {
            changes: {
              [params.textDocument.uri]: [{
                range: {
                  start: { line: insertLine, character: 0 },
                  end: { line: insertLine, character: 0 },
                },
                newText: insertText,
              }],
            },
          },
        });
      }
    }

    // 2. 要件なし主張へのテンプレート追加
    if (diagnostic.message.includes('要件または事実のあてはめがありません')) {
      // 主張を解析して条文を特定
      const claimMatch = lineText.match(/#([^\^<=:\s]+)/);
      const refMatch = lineText.match(/\^([^\s<=:]+)/);

      let insertText = '';

      // 条文データベースからテンプレートを取得
      const articleQuery = refMatch?.[1] || claimMatch?.[1];
      const article = articleQuery ? findArticle(articleDatabase, articleQuery) : undefined;

      if (article) {
        // 条文から要件テンプレートを生成
        const requirements = article.アノテーション.filter(a => a.種別 === '要件' && a.範囲);
        if (requirements.length > 0) {
          insertText = requirements.map(req => {
            const norm = req.解釈?.[0]?.規範;
            return norm
              ? `    *${req.範囲}: %${norm} <= 【あてはめ】`
              : `    *${req.範囲} <= 【あてはめ】`;
          }).join('\n') + '\n';
        }
      }

      // フォールバック：基本テンプレート
      if (!insertText) {
        insertText = '    *要件1 <= 【事実をあてはめる】\n    *要件2 <= 【事実をあてはめる】\n';
      }

      // 行末が : で終わっていない場合は : を追加
      const needsColon = !lineText.trimEnd().endsWith(':');

      actions.push({
        title: '要件テンプレートを追加',
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [params.textDocument.uri]: needsColon ? [
              {
                range: {
                  start: { line: diagLine, character: lineText.length },
                  end: { line: diagLine, character: lineText.length },
                },
                newText: ':',
              },
              {
                range: {
                  start: { line: diagLine + 1, character: 0 },
                  end: { line: diagLine + 1, character: 0 },
                },
                newText: insertText,
              },
            ] : [{
              range: {
                start: { line: diagLine + 1, character: 0 },
                end: { line: diagLine + 1, character: 0 },
              },
              newText: insertText,
            }],
          },
        },
      });
    }

    // 3. 構文エラー「予期しないトークン」への対応
    if (diagnostic.message.includes('予期しないトークン')) {
      // 条文なしの主張 #主張^ の場合
      if (lineText.match(/#[^\^]+\^[\s]*$/)) {
        actions.push({
          title: '条文番号を追加',
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [params.textDocument.uri]: [{
                range: {
                  start: { line: diagLine, character: lineText.length },
                  end: { line: diagLine, character: lineText.length },
                },
                newText: '【条文番号】',
              }],
            },
          },
        });
      }
    }

    // 4. 全角スペースを半角に置換
    if (diagnostic.data?.type === 'fullWidthSpace') {
      actions.push({
        title: '全角スペースを半角に置換',
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        isPreferred: true,
        edit: {
          changes: {
            [params.textDocument.uri]: [{
              range: diagnostic.range,
              newText: ' ',  // 半角スペース
            }],
          },
        },
      });
    }

    // 6. 孤立した要件・規範・論点への対応（主張で囲む提案）
    if (diagnostic.message.includes('主張（#）の内部に記述してください') ||
        diagnostic.message.includes('主張（#）の後に記述してください') ||
        diagnostic.message.includes('主張（#）または名前空間（::）の内部に記述してください')) {
      // 前の行に主張を追加する提案
      actions.push({
        title: '主張を追加して囲む',
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [params.textDocument.uri]: [{
              range: {
                start: { line: diagLine, character: 0 },
                end: { line: diagLine, character: 0 },
              },
              newText: '#【主張名】^【条文番号】 <= 【事実】:\n',
            }],
          },
        },
      });
    }

    // 7. 論点推奨への対応
    if (diagnostic.message.includes('論点') && diagnostic.message.includes('推奨')) {
      const issueMatch = diagnostic.message.match(/「([^」]+)」/);
      if (issueMatch) {
        const issueName = issueMatch[1];

        // 条文データベースから論点情報を取得
        const claimMatch = lineText.match(/#([^\^<=:\s]+)/);
        const refMatch = lineText.match(/\^([^\s<=:]+)/);
        const articleQuery = refMatch?.[1] || claimMatch?.[1];
        const article = articleQuery ? findArticle(articleDatabase, articleQuery) : undefined;

        let issueText = `    ? ${issueName} ~> 【理由】 => %【規範】\n`;

        if (article) {
          const issues = getIssues(article);
          const foundIssue = issues.find(i => i.issue.問題?.includes(issueName));
          if (foundIssue && foundIssue.issue.解釈?.[0]?.規範) {
            issueText = `    ? ${issueName} ~> ${foundIssue.issue.理由 || '【理由】'} => %${foundIssue.issue.解釈[0].規範}\n`;
          }
        }

        // 挿入位置を探す（トップレベルコメントや空行も境界として扱う）
        let insertLine = diagLine + 1;
        for (let i = diagLine + 1; i < lines.length; i++) {
          const l = lines[i];
          if (l.match(/^\s*#/) || l.match(/^\s*::/) || l.match(/^\s*>>/) ||
              l.match(/^\/\//) || l.trim() === '') {
            insertLine = i;
            break;
          }
          if (l.match(/^\s+\*/) || l.match(/^\s+%/) || l.match(/^\s+\?/) || l.match(/^\s+;/)) {
            insertLine = i + 1;
          }
        }

        actions.push({
          title: `論点: ${issueName} を追加`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [params.textDocument.uri]: [{
                range: {
                  start: { line: insertLine, character: 0 },
                  end: { line: insertLine, character: 0 },
                },
                newText: issueText,
              }],
            },
          },
        });
      }
    }
  }

  // カーソル位置での追加アクション（診断に関係なく）
  const cursorLine = params.range.start.line;
  const cursorLineText = lines[cursorLine] || '';

  // 主張行で効果を追加
  if (cursorLineText.match(/^\s*[+!]?#/)) {
    // 効果がまだない場合
    let hasEffect = false;
    for (let i = cursorLine + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.match(/^\s*#/) || l.match(/^\s*::/)) break;
      if (l.match(/^\s*>>/)) {
        hasEffect = true;
        break;
      }
    }

    if (!hasEffect) {
      // 効果の挿入位置を探す（トップレベルコメントや空行も境界として扱う）
      let insertLine = cursorLine + 1;
      for (let i = cursorLine + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.match(/^\s*#/) || l.match(/^\s*::/) || l.match(/^\/\//) || l.trim() === '') {
          insertLine = i;
          break;
        }
        // インデントされた要件行があれば更新
        if (l.match(/^\s+\*/) || l.match(/^\s+%/) || l.match(/^\s+\?/) || l.match(/^\s+;/)) {
          insertLine = i + 1;
        }
      }

      actions.push({
        title: '効果（>>）を追加',
        kind: CodeActionKind.Source,
        edit: {
          changes: {
            [params.textDocument.uri]: [{
              range: {
                start: { line: insertLine, character: 0 },
                end: { line: insertLine, character: 0 },
              },
              newText: '>> 【結論を記載】\n',
            }],
          },
        },
      });
    }
  }

  return actions;
});

// ドキュメントシンボル（案B+C: 条文構造+論証フロー）
connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const cached = documentCache.get(params.textDocument.uri);
  if (!cached) return [];

  const symbols: DocumentSymbol[] = [];

  function createSymbol(
    name: string,
    kind: SymbolKind,
    range: { start: { line: number; column: number }; end: { line: number; column: number } },
    children?: DocumentSymbol[],
    detail?: string
  ): DocumentSymbol {
    return {
      name,
      kind,
      detail,
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

  // 要件の充足状況を判定
  function getRequirementStatus(req: Requirement): string {
    if (req.concluded === 'positive') return '✅';
    if (req.concluded === 'negative') return '❌';
    if (req.issue) return '⚠️';  // 論点あり
    if (req.fact) return '○';    // あてはめあり（未確定）
    return '・';                  // 未検討
  }

  // 要件をシンボルに変換
  function processRequirement(req: Requirement): DocumentSymbol | null {
    if (!req || !req.name || !req.range) return null;

    const status = getRequirementStatus(req);
    const children: DocumentSymbol[] = [];

    // 規範があれば表示
    if (req.norm && req.norm.content) {
      children.push(createSymbol(
        `%${req.norm.content.substring(0, 30)}${req.norm.content.length > 30 ? '...' : ''}`,
        SymbolKind.Function,
        req.norm.range || req.range,
        undefined,
        '規範'
      ));
    }

    // あてはめがあれば表示
    if (req.fact && req.fact.content) {
      children.push(createSymbol(
        `<= ${req.fact.content.substring(0, 30)}${req.fact.content.length > 30 ? '...' : ''}`,
        SymbolKind.String,
        req.fact.range || req.range,
        undefined,
        'あてはめ'
      ));
    }

    // 論点があれば表示
    if (req.issue && req.issue.question) {
      children.push(createSymbol(
        `? ${req.issue.question}`,
        SymbolKind.Interface,
        req.issue.range || req.range,
        undefined,
        '論点'
      ));
    }

    // 下位要件
    if (req.subRequirements && req.subRequirements.length > 0) {
      for (const sub of req.subRequirements) {
        const subSymbol = processRequirement(sub);
        if (subSymbol) children.push(subSymbol);
      }
    }

    return createSymbol(
      `${status} *${req.name}`,
      SymbolKind.Property,
      req.range,
      children.length > 0 ? children : undefined,
      req.concluded === 'positive' ? '充足' : req.concluded === 'negative' ? '不充足' : undefined
    );
  }

  // 主張をシンボルに変換（論証フロー形式）
  function processClaim(claim: Claim): DocumentSymbol | null {
    if (!claim || !claim.range) return null;

    const children: DocumentSymbol[] = [];

    // 条文情報を取得
    const articleRef = claim.reference?.citation || '';
    const claimTitle = articleRef
      ? `#${claim.name}（${articleRef}）`
      : `#${claim.name || '(名前なし)'}`;

    // 充足状況のサマリーを計算
    let fulfilled = 0;
    let unfulfilled = 0;
    let pending = 0;
    let hasIssue = false;

    for (const req of claim.requirements || []) {
      if (req.concluded === 'positive') fulfilled++;
      else if (req.concluded === 'negative') unfulfilled++;
      else pending++;
      if (req.issue) hasIssue = true;
    }

    const total = (claim.requirements || []).length;
    const summary = total > 0 ? `${fulfilled}/${total}充足` : '';

    // 【構成要件】グループ
    if (claim.requirements && claim.requirements.length > 0) {
      const reqSymbols: DocumentSymbol[] = [];
      for (const req of claim.requirements) {
        const reqSymbol = processRequirement(req);
        if (reqSymbol) reqSymbols.push(reqSymbol);
      }

      if (reqSymbols.length > 0) {
        // 構成要件グループのrangeは最初の要件から最後の要件まで
        const groupRange = {
          start: claim.requirements[0].range.start,
          end: claim.requirements[claim.requirements.length - 1].range.end
        };
        children.push(createSymbol(
          `【構成要件】${hasIssue ? '⚠️' : ''} ${summary}`,
          SymbolKind.Struct,
          groupRange,
          reqSymbols
        ));
      }
    }

    // 【結論】グループ
    if (claim.effect && claim.effect.content && claim.effect.range) {
      const conclusionStatus = claim.concluded === 'positive' ? '✅' :
                               claim.concluded === 'negative' ? '❌' :
                               unfulfilled > 0 ? '❌' :
                               fulfilled === total && total > 0 ? '✅' : '？';
      children.push(createSymbol(
        `【結論】${conclusionStatus} >> ${claim.effect.content}`,
        SymbolKind.Event,
        claim.effect.range
      ));
    }

    return createSymbol(
      claimTitle,
      SymbolKind.Class,
      claim.range,
      children.length > 0 ? children : undefined,
      summary
    );
  }

  // ドキュメントの子要素を処理
  for (const child of cached.document.children) {
    if (!child || !child.range) continue;

    if (child.type === 'Namespace') {
      const nsChildren: DocumentSymbol[] = [];
      for (const nsChild of child.children) {
        if (nsChild.type === 'Claim') {
          const symbol = processClaim(nsChild);
          if (symbol) nsChildren.push(symbol);
        }
      }
      symbols.push(createSymbol(
        `::${child.name || '(名前なし)'}`,
        SymbolKind.Namespace,
        child.range,
        nsChildren.length > 0 ? nsChildren : undefined
      ));
    } else if (child.type === 'Claim') {
      const symbol = processClaim(child);
      if (symbol) symbols.push(symbol);
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
    if ((match = /\*([^\s:<=]+)/.exec(line))) {
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
