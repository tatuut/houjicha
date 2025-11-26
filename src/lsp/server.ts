/**
 * 本件 Matcha - Language Server Protocol サーバー
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
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { parse, ParseResult, ParseError } from '../language/parser';
import { Document, Claim, Namespace, Requirement, Norm, Issue, ASTNode } from '../language/ast';

// 接続を作成
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ドキュメントのパース結果をキャッシュ
const documentCache = new Map<string, ParseResult>();

// セマンティックトークンの凡例
const tokenTypes = [
  'namespace',    // 論述空間
  'keyword',      // キーワード（#, %, ?, >>）
  'string',       // 要件名「」
  'function',     // 規範
  'variable',     // 定数
  'comment',      // コメント
  'operator',     // 演算子
  'type',         // 根拠条文
  'parameter',    // 評価
];

const tokenModifiers = [
  'declaration',
  'definition',
  'readonly',
];

const legend: SemanticTokensLegend = {
  tokenTypes,
  tokenModifiers,
};

// 初期化
connection.onInitialize((params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['#', '%', '「', '^', '@', '$', '?', ':'],
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: {
        legend,
        full: true,
      },
    },
  };
});

// ドキュメント変更時の処理
documents.onDidChangeContent(change => {
  validateDocument(change.document);
});

// ドキュメントを検証して診断情報を送信
async function validateDocument(textDocument: TextDocument): Promise<void> {
  const text = textDocument.getText();
  const result = parse(text);

  // キャッシュを更新
  documentCache.set(textDocument.uri, result);

  // エラーを診断情報に変換
  const diagnostics: Diagnostic[] = result.errors.map(error => ({
    severity: DiagnosticSeverity.Error,
    range: {
      start: {
        line: error.range.start.line,
        character: error.range.start.column,
      },
      end: {
        line: error.range.end.line,
        character: error.range.end.column,
      },
    },
    message: error.message,
    source: '本件 Matcha',
  }));

  // 追加の検証
  diagnostics.push(...validateSemantics(result.document));

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// 意味的な検証
function validateSemantics(doc: Document): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // 主張に要件がない場合の警告
  function checkClaim(claim: Claim): void {
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
    if (claim.concluded !== undefined) {
      const hasNegativeReq = claim.requirements.some(r => r.concluded === 'negative');
      if (claim.concluded === 'positive' && hasNegativeReq) {
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

// 補完
connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const text = document.getText();
  const offset = document.offsetAt(params.position);
  const lineText = text.substring(
    text.lastIndexOf('\n', offset - 1) + 1,
    offset
  );

  const items: CompletionItem[] = [];

  // # の後：一般的な罪名・法的概念
  if (lineText.endsWith('#') || lineText.match(/#\S*$/)) {
    items.push(
      { label: '窃盗罪', kind: CompletionItemKind.Class, detail: '刑法235条' },
      { label: '強盗罪', kind: CompletionItemKind.Class, detail: '刑法236条' },
      { label: '詐欺罪', kind: CompletionItemKind.Class, detail: '刑法246条' },
      { label: '殺人罪', kind: CompletionItemKind.Class, detail: '刑法199条' },
      { label: '傷害罪', kind: CompletionItemKind.Class, detail: '刑法204条' },
      { label: '不法行為', kind: CompletionItemKind.Class, detail: '民法709条' },
      { label: '債務不履行', kind: CompletionItemKind.Class, detail: '民法415条' },
    );
  }

  // ^ の後：条文番号
  if (lineText.endsWith('^') || lineText.match(/\^\S*$/)) {
    items.push(
      { label: '刑法235条', kind: CompletionItemKind.Reference, detail: '窃盗罪' },
      { label: '刑法236条', kind: CompletionItemKind.Reference, detail: '強盗罪' },
      { label: '刑法246条', kind: CompletionItemKind.Reference, detail: '詐欺罪' },
      { label: '刑法199条', kind: CompletionItemKind.Reference, detail: '殺人罪' },
      { label: '民法709条', kind: CompletionItemKind.Reference, detail: '不法行為' },
      { label: '民法415条', kind: CompletionItemKind.Reference, detail: '債務不履行' },
      { label: '38条1項本文', kind: CompletionItemKind.Reference, detail: '故意' },
    );
  }

  // % の後：規範のテンプレート
  if (lineText.endsWith('%') || lineText.match(/%\S*$/)) {
    items.push(
      { label: '事実の認識・認容', kind: CompletionItemKind.Function, detail: '故意の定義' },
      { label: '占有者の意思に反して占有を自己又は第三者に移転すること', kind: CompletionItemKind.Function, detail: '窃取の定義' },
      { label: '他人が所有する財産的価値のある有体物', kind: CompletionItemKind.Function, detail: '他人の財物' },
      { label: '人が物を実力的に支配する関係', kind: CompletionItemKind.Function, detail: '占有の定義' },
    );
  }

  // ? の後：論点テンプレート
  if (lineText.endsWith('?') || lineText.endsWith('？')) {
    items.push(
      { label: ' 意義', kind: CompletionItemKind.Snippet, insertText: ' 意義 => %' },
      { label: ' 問題提起 ~> 理由 => %規範', kind: CompletionItemKind.Snippet },
      { label: ' 財産犯と不可罰的な使用窃盗及び遺棄・隠匿罪との区別する必要がある => 不法領得の意思', kind: CompletionItemKind.Snippet },
    );
  }

  // 「の後：要件名
  if (lineText.endsWith('「')) {
    items.push(
      { label: '他人の財物」', kind: CompletionItemKind.Property },
      { label: '窃取」', kind: CompletionItemKind.Property },
      { label: '故意」', kind: CompletionItemKind.Property },
      { label: '因果関係」', kind: CompletionItemKind.Property },
      { label: '第三者」', kind: CompletionItemKind.Property },
    );
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

  // 行頭での補完
  if (lineText.trim() === '') {
    items.push(
      { label: '#', kind: CompletionItemKind.Keyword, detail: '主張', insertText: '#' },
      { label: '::', kind: CompletionItemKind.Keyword, detail: '論述空間', insertText: '::' },
      { label: '「', kind: CompletionItemKind.Keyword, detail: '要件', insertText: '「' },
      { label: '%', kind: CompletionItemKind.Keyword, detail: '規範', insertText: '%' },
      { label: '?', kind: CompletionItemKind.Keyword, detail: '論点', insertText: '?' },
      { label: '>>', kind: CompletionItemKind.Keyword, detail: '効果', insertText: '>>' },
      { label: '+', kind: CompletionItemKind.Keyword, detail: '該当', insertText: '+' },
      { label: '!', kind: CompletionItemKind.Keyword, detail: '否定', insertText: '!' },
    );
  }

  return items;
});

// 補完アイテムの詳細
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  return item;
});

// ホバー
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const cached = documentCache.get(params.textDocument.uri);
  if (!cached) return null;

  const position = params.position;
  const text = document.getText();
  const lines = text.split('\n');
  const line = lines[position.line] || '';

  // 記号のホバー情報
  const hoverInfo: { [key: string]: { title: string; description: string } } = {
    '#': {
      title: '主張（Claim）',
      description: '法的主張を示します。根拠条文（^）と事実へのあてはめ（<=）を続けて記述します。\n\n例: `#窃盗罪^刑法235条 <= 甲の行為`',
    },
    '%': {
      title: '規範（Norm）',
      description: '法的規範・解釈を示します。条文の文言を法的概念として定義します。\n\n例: `%占有者の意思に反して占有を移転`',
    },
    '「': {
      title: '要件（Requirement）',
      description: '条文の構成要件を示します。「」で囲んで記述します。\n\n例: `「他人の財物」`',
    },
    '?': {
      title: '論点（Issue）',
      description: '法的論点を提起します。理由（~>）と規範（=>）を続けて記述できます。\n\n例: `? 意義 ~> 趣旨 => %規範`',
    },
    '>>': {
      title: '効果（Effect）',
      description: '法的効果・結論を示します。\n\n例: `>> 甲に窃盗罪が成立する`',
    },
    '<=': {
      title: 'あてはめ（Application）',
      description: '事実を法的概念にあてはめます。\n\n例: `<= 本件財布はAが所有する`',
    },
    '@': {
      title: '評価（Evaluation）',
      description: '事実に対する法的評価を示します。\n\n例: `甲@占有者`',
    },
    '^': {
      title: '根拠条文（Reference）',
      description: '主張や規範の根拠となる条文を示します。\n\n例: `^刑法235条`',
    },
    '::': {
      title: '論述空間（Namespace）',
      description: '答案構成上の分類を示します。\n\n例: `::甲の罪責`',
    },
    '+': {
      title: '該当（Positive Conclusion）',
      description: '要件に該当することを示します。',
    },
    '!': {
      title: '否定（Negative Conclusion）',
      description: '要件に該当しないことを示します。',
    },
    '~>': {
      title: '理由（Reason）',
      description: '論点における規範定立の理由を示します。',
    },
    '=>': {
      title: '帰結（Implies）',
      description: '論点から規範への帰結を示します。',
    },
    'as': {
      title: '定数定義（Constant Definition）',
      description: '規範を定数として定義し、後から参照できるようにします。\n\n例: `as 第三者の規範`',
    },
    '$': {
      title: '定数参照（Constant Reference）',
      description: '定義済みの定数を参照します。\n\n例: `$第三者の規範`',
    },
  };

  // カーソル位置の記号を特定
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
      return createSymbol(
        req.name,
        SymbolKind.Property,
        req.range,
        children.length > 0 ? children : undefined
      );
    });
  }

  function processClaim(claim: Claim): DocumentSymbol {
    const prefix = claim.concluded === 'positive' ? '+' : claim.concluded === 'negative' ? '!' : '';
    const children = processRequirements(claim.requirements);
    if (claim.effect) {
      children.push(createSymbol(
        claim.effect.content,
        SymbolKind.Event,
        claim.effect.range
      ));
    }
    return createSymbol(
      `${prefix}#${claim.name}`,
      SymbolKind.Class,
      claim.range,
      children.length > 0 ? children : undefined
    );
  }

  for (const child of cached.document.children) {
    if (child.type === 'Namespace') {
      const nsChildren: DocumentSymbol[] = [];
      for (const nsChild of child.children) {
        if (nsChild.type === 'Claim') {
          nsChildren.push(processClaim(nsChild));
        }
      }
      symbols.push(createSymbol(
        `::${child.name}`,
        SymbolKind.Namespace,
        child.range,
        nsChildren.length > 0 ? nsChildren : undefined
      ));
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

  const cached = documentCache.get(params.textDocument.uri);
  if (!cached) return { data: [] };

  const builder = new SemanticTokensBuilder();
  const text = document.getText();
  const lines = text.split('\n');

  // 簡易的なトークン化（より詳細な実装は lexer の結果を使用）
  lines.forEach((line, lineIndex) => {
    let match: RegExpExecArray | null;

    // 論述空間
    if ((match = /^(\s*)(::)(.*)/.exec(line))) {
      builder.push(lineIndex, match[1].length, 2, tokenTypes.indexOf('keyword'), 0);
      builder.push(lineIndex, match[1].length + 2, match[3].length, tokenTypes.indexOf('namespace'), 0);
    }

    // コメント
    if ((match = /\/\/(.*)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('comment'), 0);
    }

    // 主張
    if ((match = /([+!]?)#([^\\^<=:]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('keyword'), 0);
    }

    // 根拠条文
    if ((match = /\^([^<=:\s]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('type'), 0);
    }

    // 要件
    if ((match = /「([^」]+)」/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('string'), 0);
    }

    // 規範
    if ((match = /([+!]?)%([^<=:\s@]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('function'), 0);
    }

    // 評価
    if ((match = /@([^\s&|)]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('parameter'), 0);
    }

    // 定数
    if ((match = /\$([^\s<=:]+)/.exec(line))) {
      builder.push(lineIndex, match.index, match[0].length, tokenTypes.indexOf('variable'), 0);
    }
  });

  return builder.build();
});

// ドキュメントマネージャーと接続を開始
documents.listen(connection);
connection.listen();
