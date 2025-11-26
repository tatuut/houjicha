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
  CodeAction,
  CodeActionKind,
  CodeActionParams,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { parse, ParseResult } from '../language/parser';
import { Document, Claim, Requirement, ASTNode } from '../language/ast';
import { statuteManager, Statute, StatuteRequirement, parseStatuteKey } from '../language/statute';

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
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
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

    // 条文に基づく要件網羅性チェック
    if (claim.reference) {
      const statute = findStatuteFromReference(claim.reference.citation);
      if (statute) {
        const missingReqs = checkRequirementCoverage(statute, claim.requirements);
        if (missingReqs.length > 0) {
          diagnostics.push({
            severity: DiagnosticSeverity.Information,
            range: {
              start: { line: claim.range.start.line, character: claim.range.start.column },
              end: { line: claim.range.end.line, character: claim.range.end.column },
            },
            message: `以下の要件が検討されていません: ${missingReqs.join(', ')}`,
            source: '本件 Matcha',
            data: { missingRequirements: missingReqs, statute: statute.name },
          });
        }

        // 書かれざる要件のチェック
        if (statute.unwrittenRequirements && statute.unwrittenRequirements.length > 0) {
          const missingUnwritten = checkUnwrittenRequirements(statute, claim.requirements);
          if (missingUnwritten.length > 0) {
            diagnostics.push({
              severity: DiagnosticSeverity.Hint,
              range: {
                start: { line: claim.range.start.line, character: claim.range.start.column },
                end: { line: claim.range.end.line, character: claim.range.end.column },
              },
              message: `書かれざる要件の検討: ${missingUnwritten.join(', ')}`,
              source: '本件 Matcha',
              data: { missingUnwritten, statute: statute.name },
            });
          }
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

// 条文参照から条文を検索
function findStatuteFromReference(citation: string): Statute | undefined {
  // 条文番号のパターンを試行
  const patterns = [
    citation,
    citation.replace(/第/g, ''),
    citation.replace(/条$/, ''),
  ];

  for (const pattern of patterns) {
    const statute = statuteManager.find(pattern);
    if (statute) return statute;
  }

  // 部分一致検索
  const results = statuteManager.search(citation);
  return results[0];
}

// 要件の網羅性チェック
function checkRequirementCoverage(statute: Statute, requirements: Requirement[]): string[] {
  const missing: string[] = [];
  const reqNames = new Set(requirements.map(r => r.name));

  function checkReq(statuteReq: StatuteRequirement): void {
    if (statuteReq.required !== false && !reqNames.has(statuteReq.name)) {
      // 規範名でも探す
      const foundByNorm = requirements.some(r =>
        r.norm?.content.includes(statuteReq.name) ||
        (statuteReq.norm && r.norm?.content.includes(statuteReq.norm))
      );
      if (!foundByNorm) {
        missing.push(statuteReq.name);
      }
    }
    // 下位要件もチェック（ただし親要件が検討されている場合のみ）
    if (statuteReq.subRequirements && reqNames.has(statuteReq.name)) {
      for (const subReq of statuteReq.subRequirements) {
        checkReq(subReq);
      }
    }
  }

  for (const req of statute.requirements) {
    checkReq(req);
  }

  return missing;
}

// 書かれざる要件のチェック
function checkUnwrittenRequirements(statute: Statute, requirements: Requirement[]): string[] {
  if (!statute.unwrittenRequirements) return [];

  const missing: string[] = [];
  const reqNames = new Set(requirements.map(r => r.name));

  for (const unwritten of statute.unwrittenRequirements) {
    if (!reqNames.has(unwritten.name)) {
      // 論点として検討されているかチェック
      const foundAsIssue = requirements.some(r =>
        r.issue?.norm.content.includes(unwritten.name)
      );
      if (!foundAsIssue) {
        missing.push(unwritten.name);
      }
    }
  }

  return missing;
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

  // 条文データベースから補完候補を生成
  const allStatutes = statuteManager.getAll();

  // # の後：条文データベースから罪名・法的概念
  if (lineText.endsWith('#') || lineText.match(/#\S*$/)) {
    for (const statute of allStatutes) {
      items.push({
        label: statute.name,
        kind: CompletionItemKind.Class,
        detail: `${statute.law}${statute.article}条${statute.paragraph ? statute.paragraph + '項' : ''}`,
        documentation: statute.fullText,
        insertText: `${statute.name}^${statute.law}${statute.article}条${statute.paragraph ? statute.paragraph + '項' : ''}`,
      });
    }
  }

  // ^ の後：条文番号
  if (lineText.endsWith('^') || lineText.match(/\^\S*$/)) {
    for (const statute of allStatutes) {
      const citation = `${statute.law}${statute.article}条${statute.paragraph ? statute.paragraph + '項' : ''}`;
      items.push({
        label: citation,
        kind: CompletionItemKind.Reference,
        detail: statute.name,
        documentation: statute.fullText,
      });
    }
  }

  // % の後：規範のテンプレート（条文データベースから）
  if (lineText.endsWith('%') || lineText.match(/%\S*$/)) {
    for (const statute of allStatutes) {
      for (const req of statute.requirements) {
        if (req.norm) {
          items.push({
            label: req.norm,
            kind: CompletionItemKind.Function,
            detail: `${statute.name} - ${req.name}`,
          });
        }
        // 下位要件の規範も追加
        if (req.subRequirements) {
          for (const subReq of req.subRequirements) {
            if (subReq.norm) {
              items.push({
                label: subReq.norm,
                kind: CompletionItemKind.Function,
                detail: `${statute.name} - ${subReq.name}`,
              });
            }
          }
        }
      }
      // 書かれざる要件の規範も追加
      if (statute.unwrittenRequirements) {
        for (const unwritten of statute.unwrittenRequirements) {
          if (unwritten.norm) {
            items.push({
              label: unwritten.norm,
              kind: CompletionItemKind.Function,
              detail: `${statute.name} - ${unwritten.name}（書かれざる要件）`,
            });
          }
        }
      }
    }
  }

  // ? の後：論点テンプレート
  if (lineText.endsWith('?') || lineText.endsWith('？')) {
    // 論点になりやすい要件を提案
    for (const statute of allStatutes) {
      const collectIssues = (reqs: StatuteRequirement[]): void => {
        for (const req of reqs) {
          if (req.isIssue) {
            items.push({
              label: req.issueQuestion || `${req.name}の意義`,
              kind: CompletionItemKind.Snippet,
              detail: statute.name,
              insertText: ` ${req.issueQuestion || req.name + 'の意義'} => %${req.norm || req.name}`,
            });
          }
          if (req.subRequirements) {
            collectIssues(req.subRequirements);
          }
        }
      };
      collectIssues(statute.requirements);
      if (statute.unwrittenRequirements) {
        collectIssues(statute.unwrittenRequirements);
      }
    }
  }

  // 「の後：要件名（条文データベースから）
  if (lineText.endsWith('「')) {
    for (const statute of allStatutes) {
      const collectReqNames = (reqs: StatuteRequirement[]): void => {
        for (const req of reqs) {
          items.push({
            label: `${req.name}」`,
            kind: CompletionItemKind.Property,
            detail: statute.name,
            documentation: req.norm,
          });
          if (req.subRequirements) {
            collectReqNames(req.subRequirements);
          }
        }
      };
      collectReqNames(statute.requirements);
    }
  }

  // 現在の主張の根拠条文に基づく要件補完
  const claimMatch = text.match(/#(\S+)\^([^\s<=:]+)/);
  if (claimMatch && (lineText.trim() === '' || lineText.match(/^\s+$/))) {
    const statute = findStatuteFromReference(claimMatch[2]);
    if (statute) {
      // 未検討の要件を提案
      const cached = documentCache.get(params.textDocument.uri);
      if (cached) {
        const collectReqs = (reqs: StatuteRequirement[], indent: string = '    '): void => {
          for (const req of reqs) {
            items.push({
              label: `「${req.name}」`,
              kind: CompletionItemKind.Snippet,
              detail: '未検討の要件',
              insertText: req.norm
                ? `${indent}「${req.name}」: %${req.norm} <= `
                : `${indent}「${req.name}」 <= `,
              sortText: '0' + req.name, // 優先表示
            });
          }
        };
        collectReqs(statute.requirements);
        if (statute.unwrittenRequirements) {
          for (const unwritten of statute.unwrittenRequirements) {
            items.push({
              label: `? ${unwritten.issueQuestion || unwritten.name}`,
              kind: CompletionItemKind.Snippet,
              detail: '書かれざる要件（論点）',
              insertText: `    ? ${unwritten.issueQuestion || unwritten.name + 'の要否'} => ${unwritten.name}:\n        %${unwritten.norm || ''} <= `,
              sortText: '1' + unwritten.name,
            });
          }
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

  // 条文参照のホバー（^の後の条文番号）
  const refMatch = line.match(/\^([^\s<=:]+)/);
  if (refMatch) {
    const refStart = line.indexOf(refMatch[0]);
    const refEnd = refStart + refMatch[0].length;
    if (position.character >= refStart && position.character <= refEnd) {
      const statute = findStatuteFromReference(refMatch[1]);
      if (statute) {
        let content = `## ${statute.law}${statute.article}条`;
        if (statute.paragraph) content += `${statute.paragraph}項`;
        content += ` - ${statute.name}\n\n`;
        if (statute.fullText) {
          content += `> ${statute.fullText}\n\n`;
        }
        content += `### 要件\n`;
        const formatReqs = (reqs: StatuteRequirement[], indent: string = ''): string => {
          let result = '';
          for (const req of reqs) {
            result += `${indent}- **${req.name}**`;
            if (req.norm) result += `: ${req.norm}`;
            if (req.isIssue) result += ' ⚠️論点';
            result += '\n';
            if (req.subRequirements) {
              result += formatReqs(req.subRequirements, indent + '  ');
            }
          }
          return result;
        };
        content += formatReqs(statute.requirements);
        if (statute.unwrittenRequirements && statute.unwrittenRequirements.length > 0) {
          content += `\n### 書かれざる要件\n`;
          content += formatReqs(statute.unwrittenRequirements);
        }
        content += `\n### 効果\n${statute.effect.content}`;
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: content,
          },
        };
      }
    }
  }

  // 要件名のホバー（「」内）
  const reqMatch = line.match(/「([^」]+)」/);
  if (reqMatch) {
    const reqStart = line.indexOf(reqMatch[0]);
    const reqEnd = reqStart + reqMatch[0].length;
    if (position.character >= reqStart && position.character <= reqEnd) {
      const reqName = reqMatch[1];
      // 条文データベースから該当する要件を検索
      for (const statute of statuteManager.getAll()) {
        const findReq = (reqs: StatuteRequirement[]): StatuteRequirement | undefined => {
          for (const req of reqs) {
            if (req.name === reqName) return req;
            if (req.subRequirements) {
              const found = findReq(req.subRequirements);
              if (found) return found;
            }
          }
          return undefined;
        };
        const foundReq = findReq(statute.requirements);
        if (foundReq) {
          let content = `## 「${foundReq.name}」\n\n`;
          content += `**条文**: ${statute.law}${statute.article}条 - ${statute.name}\n\n`;
          if (foundReq.norm) {
            content += `**規範**: ${foundReq.norm}\n\n`;
          }
          if (foundReq.isIssue) {
            content += `⚠️ **論点になりやすい要件**\n`;
            if (foundReq.issueQuestion) {
              content += `問題提起: ${foundReq.issueQuestion}\n`;
            }
          }
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: content,
            },
          };
        }
      }
    }
  }

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

// コードアクション（クイックフィックス）
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const actions: CodeAction[] = [];
  const document = documents.get(params.textDocument.uri);
  if (!document) return actions;

  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.data && (diagnostic.data as any).missingRequirements) {
      const missing = (diagnostic.data as any).missingRequirements as string[];
      const statute = (diagnostic.data as any).statute as string;

      // 不足している要件を追加するアクション
      actions.push({
        title: `不足要件を追加: ${missing.join(', ')}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [params.textDocument.uri]: [{
              range: {
                start: { line: diagnostic.range.end.line, character: 0 },
                end: { line: diagnostic.range.end.line, character: 0 },
              },
              newText: missing.map(req => `    「${req}」 <= \n`).join(''),
            }],
          },
        },
      });
    }

    if (diagnostic.data && (diagnostic.data as any).missingUnwritten) {
      const missing = (diagnostic.data as any).missingUnwritten as string[];

      // 書かれざる要件を論点として追加するアクション
      actions.push({
        title: `書かれざる要件を論点として追加: ${missing.join(', ')}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          changes: {
            [params.textDocument.uri]: [{
              range: {
                start: { line: diagnostic.range.end.line, character: 0 },
                end: { line: diagnostic.range.end.line, character: 0 },
              },
              newText: missing.map(req => `    ? ${req}の要否 => ${req}:\n        % <= \n`).join(''),
            }],
          },
        },
      });
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
