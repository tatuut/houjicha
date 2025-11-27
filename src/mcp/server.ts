/**
 * ほうじ茶（Houjicha）- MCP Server
 * AIが法的推論を行うための入力補助ツール
 */

// MCP SDK imports - CommonJS互換
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

interface Tool {
  name: string;
  description: string;
  inputSchema: any;
}

import * as fs from 'fs';
import * as path from 'path';
import { parse, ParseResult } from '../language/parser';
import { Document, Claim, Requirement } from '../language/ast';
import {
  ArticleDatabase,
  ArticleData,
  loadArticleDatabase,
  findArticle,
  generateTemplate,
  getRequiredAnnotations,
  getIssues,
} from '../language/loader';

// ===== 型定義 =====

interface ValidationResult {
  errors: DiagnosticItem[];
  warnings: DiagnosticItem[];
  hints: DiagnosticItem[];
  nextSuggestions: NextSuggestion[];
}

interface DiagnosticItem {
  line: number;
  character: number;
  message: string;
  severity: 'error' | 'warning' | 'hint';
  suggestion?: string;
}

interface NextSuggestion {
  position: { line: number; character: number };
  candidates: string[];
}

interface CompletionItem {
  id: string;
  label: string;
  insertText: string;
  kind: 'requirement' | 'norm' | 'issue' | 'effect' | 'template' | 'symbol';
  detail?: string;
}

interface TemplateInfo {
  id: string;
  name: string;
  category: string;
  description?: string;
}

interface SnippetInfo {
  id: string;
  trigger: string;
  content: string;
  description?: string;
}

// ===== グローバル状態 =====

let articleDatabase: ArticleDatabase = {
  articles: new Map(),
  nameIndex: new Map(),
};

const snippets: Map<string, SnippetInfo> = new Map();

// デフォルトの作業ディレクトリ
let workingDirectory = process.cwd();

// ===== ツール定義 =====

const tools: Tool[] = [
  {
    name: 'houjicha_validate',
    description: 'ほうじ茶コードを検証し、エラー・警告・ヒントを返します。Ghost補完の情報も含まれます。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '検証する.houjichaコードの内容',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'houjicha_get_completions',
    description: '指定位置での補完候補を取得します（Ctrl+Space相当）',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '.houjichaコードの内容',
        },
        line: {
          type: 'number',
          description: 'カーソル位置の行番号（0始まり）',
        },
        character: {
          type: 'number',
          description: 'カーソル位置の列番号（0始まり）',
        },
      },
      required: ['content', 'line', 'character'],
    },
  },
  {
    name: 'houjicha_apply_completion',
    description: '補完を適用して新しいコンテンツを返します',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '.houjichaコードの内容',
        },
        line: {
          type: 'number',
          description: 'カーソル位置の行番号（0始まり）',
        },
        character: {
          type: 'number',
          description: 'カーソル位置の列番号（0始まり）',
        },
        completionId: {
          type: 'string',
          description: '適用する補完のID',
        },
      },
      required: ['content', 'line', 'character', 'completionId'],
    },
  },
  {
    name: 'houjicha_list_templates',
    description: '利用可能な条文テンプレートの一覧を取得します',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'カテゴリでフィルタ（例：刑法、民法）',
        },
      },
    },
  },
  {
    name: 'houjicha_get_template',
    description: '条文テンプレートの詳細を取得します',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'テンプレートID（例：刑法235条、窃盗罪）',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'houjicha_search_templates',
    description: 'キーワードで条文テンプレートを検索します',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '検索キーワード',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'houjicha_expand_template',
    description: 'テンプレートを展開して.houjichaコードを生成します',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: {
          type: 'string',
          description: 'テンプレートID',
        },
        subject: {
          type: 'string',
          description: '主語（例：甲の行為）',
        },
        facts: {
          type: 'array',
          items: { type: 'string' },
          description: '事実のリスト',
        },
      },
      required: ['templateId'],
    },
  },
  {
    name: 'houjicha_register_template',
    description: '新しい条文テンプレートを登録します',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'テンプレートID（例：刑法236条）' },
        name: { type: 'string', description: '名称（例：強盗罪）' },
        category: { type: 'string', description: 'カテゴリ（例：刑法）' },
        sourceText: { type: 'string', description: '条文原文' },
        requirements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              norm: { type: 'string' },
              required: { type: 'boolean' },
            },
          },
          description: '要件のリスト',
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              reason: { type: 'string' },
              norm: { type: 'string' },
              required: { type: 'boolean' },
            },
          },
          description: '論点のリスト',
        },
      },
      required: ['id', 'name', 'category'],
    },
  },
  {
    name: 'houjicha_add_to_template',
    description: '既存のテンプレートに要件や論点を追加します',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', description: 'テンプレートID' },
        type: { type: 'string', enum: ['requirement', 'issue'], description: '追加する種別' },
        name: { type: 'string', description: '名前' },
        norm: { type: 'string', description: '規範' },
        reason: { type: 'string', description: '理由（論点の場合）' },
        required: { type: 'boolean', description: '必須かどうか' },
      },
      required: ['templateId', 'type', 'name'],
    },
  },
  {
    name: 'houjicha_list_snippets',
    description: 'カスタムスニペットの一覧を取得します',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'houjicha_register_snippet',
    description: 'カスタムスニペットを登録します',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'スニペットID' },
        trigger: { type: 'string', description: 'トリガー文字列（例：/損害賠償）' },
        content: { type: 'string', description: '展開されるコンテンツ' },
        description: { type: 'string', description: '説明' },
      },
      required: ['id', 'trigger', 'content'],
    },
  },
  {
    name: 'houjicha_set_working_directory',
    description: '作業ディレクトリを設定し、条文データベースを読み込みます',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '作業ディレクトリのパス',
        },
      },
      required: ['path'],
    },
  },
];

// ===== バリデーション =====

function validateContent(content: string): ValidationResult {
  const result: ValidationResult = {
    errors: [],
    warnings: [],
    hints: [],
    nextSuggestions: [],
  };

  // パース
  const parseResult = parse(content);

  // パースエラー
  for (const error of parseResult.errors) {
    result.errors.push({
      line: error.range.start.line,
      character: error.range.start.column,
      message: error.message,
      severity: 'error',
    });
  }

  // 意味的検証
  const doc = parseResult.document;
  validateDocument(doc, result);

  // Ghost補完のヒント
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lastChar = line[line.length - 1];

    if (lastChar === '~' && !line.endsWith('~>')) {
      result.hints.push({
        line: i,
        character: line.length,
        message: '~の後には>を入力してください',
        severity: 'hint',
        suggestion: '>',
      });
    }
    if (lastChar === '=' && !line.endsWith('<=') && !line.endsWith('=>')) {
      result.hints.push({
        line: i,
        character: line.length,
        message: '=の後には>を入力してください',
        severity: 'hint',
        suggestion: '>',
      });
    }
    if (lastChar === '<' && !line.endsWith('<=')) {
      result.hints.push({
        line: i,
        character: line.length,
        message: '<の後には=を入力してください',
        severity: 'hint',
        suggestion: '=',
      });
    }
    if (lastChar === '>' && !line.endsWith('>>') && !line.endsWith('=>') && !line.endsWith('~>')) {
      result.hints.push({
        line: i,
        character: line.length,
        message: '>の後には>を入力してください',
        severity: 'hint',
        suggestion: '>',
      });
    }
  }

  // 次の入力候補
  const lastLine = lines.length - 1;
  const lastLineContent = lines[lastLine] || '';
  const trimmed = lastLineContent.trim();

  if (trimmed === '' || trimmed.endsWith(':')) {
    result.nextSuggestions.push({
      position: { line: lastLine, character: lastLineContent.length },
      candidates: ['*要件名', '%規範', '?論点', '>>結論'],
    });
  }

  return result;
}

function validateDocument(doc: Document, result: ValidationResult): void {
  for (const child of doc.children) {
    if (child.type === 'Claim') {
      validateClaim(child as Claim, result);
    } else if (child.type === 'Namespace') {
      for (const nsChild of child.children) {
        if (nsChild.type === 'Claim') {
          validateClaim(nsChild as Claim, result);
        }
      }
    }
  }
}

function validateClaim(claim: Claim, result: ValidationResult): void {
  // 要件がない
  if (claim.requirements.length === 0 && !claim.fact) {
    result.warnings.push({
      line: claim.range.start.line,
      character: claim.range.start.column,
      message: '主張に要件または事実のあてはめがありません',
      severity: 'warning',
    });
  }

  // 条文データベースとの照合
  const article = findArticleForClaim(claim);
  if (article) {
    const requiredAnnotations = getRequiredAnnotations(article);
    const writtenRequirements = new Set<string>();

    for (const req of claim.requirements) {
      writtenRequirements.add(req.name);
      if (req.subRequirements) {
        for (const sub of req.subRequirements) {
          writtenRequirements.add(sub.name);
        }
      }
    }

    // 必須要件の欠落チェック
    for (const annotation of requiredAnnotations) {
      const reqName = annotation.範囲 || annotation.name || '';
      if (reqName && !writtenRequirements.has(reqName)) {
        const found = Array.from(writtenRequirements).some(w =>
          w.includes(reqName) || reqName.includes(w)
        );
        if (!found) {
          const severity = annotation.必須 !== false ? 'error' : 'warning';
          result[severity === 'error' ? 'errors' : 'warnings'].push({
            line: claim.range.start.line,
            character: claim.range.start.column,
            message: `必須要件「${reqName}」が未検討です`,
            severity,
          });
        }
      }
    }

    // 論点の検討推奨
    const issues = getIssues(article);
    for (const { issue } of issues) {
      const hasIssue = claim.requirements.some(req =>
        req.issue?.question?.includes(issue.問題) ||
        req.name.includes(issue.問題)
      );
      if (!hasIssue && issue.問題) {
        result.hints.push({
          line: claim.range.start.line,
          character: claim.range.start.column,
          message: `論点「${issue.問題}」の検討を推奨`,
          severity: 'hint',
        });
      }
    }
  }
}

function findArticleForClaim(claim: Claim): ArticleData | undefined {
  if (claim.reference?.citation) {
    return findArticle(articleDatabase, claim.reference.citation);
  }
  return findArticle(articleDatabase, claim.name);
}

// ===== 補完 =====

function getCompletions(content: string, line: number, character: number): CompletionItem[] {
  const items: CompletionItem[] = [];
  const lines = content.split('\n');
  const currentLine = lines[line] || '';
  const textBeforeCursor = currentLine.substring(0, character);
  const trimmed = textBeforeCursor.trim();

  // 記号ガイド（空行）
  if (trimmed === '') {
    const isIndented = textBeforeCursor.startsWith(' ') || textBeforeCursor.startsWith('\t');

    if (isIndented) {
      items.push(
        { id: 'sym_req', label: '*', insertText: '*', kind: 'symbol', detail: '要件' },
        { id: 'sym_norm', label: '%', insertText: '%', kind: 'symbol', detail: '規範（解釈）' },
        { id: 'sym_issue', label: '?', insertText: '? ', kind: 'symbol', detail: '論点' },
        { id: 'sym_reason', label: '~>', insertText: '~> ', kind: 'symbol', detail: '理由' },
        { id: 'sym_imply', label: '=>', insertText: '=> ', kind: 'symbol', detail: '帰結' },
        { id: 'sym_apply', label: '<=', insertText: '<= ', kind: 'symbol', detail: 'あてはめ' },
      );
    } else {
      items.push(
        { id: 'sym_claim', label: '#', insertText: '#', kind: 'symbol', detail: '主張（罪名・請求原因）' },
        { id: 'sym_ns', label: '::', insertText: '::', kind: 'symbol', detail: '論述空間' },
        { id: 'sym_effect', label: '>>', insertText: '>> ', kind: 'effect', detail: '効果（結論）' },
        { id: 'sym_gen', label: '/gen', insertText: '/gen', kind: 'template', detail: 'テンプレート生成' },
      );
    }
  }

  // # の後（主張名）
  if (trimmed === '#') {
    for (const [id, article] of articleDatabase.articles) {
      items.push({
        id: `claim_${id}`,
        label: article.名称 || id,
        insertText: `${article.名称 || id}^${id}`,
        kind: 'template',
        detail: id,
      });
    }
  }

  // * の後（要件）
  if (trimmed === '*' || trimmed === '＊') {
    const claim = findCurrentClaim(content, line);
    if (claim) {
      const article = findArticleForClaim(claim);
      if (article) {
        for (const annotation of article.アノテーション) {
          if (annotation.種別 === '要件' && annotation.範囲) {
            items.push({
              id: `req_${annotation.範囲}`,
              label: annotation.範囲,
              insertText: annotation.範囲,
              kind: 'requirement',
              detail: annotation.解釈?.[0]?.規範,
            });
          }
        }
      }
    }
  }

  // ? の後（論点）
  if (trimmed === '?' || trimmed === '？') {
    const claim = findCurrentClaim(content, line);
    if (claim) {
      const article = findArticleForClaim(claim);
      if (article) {
        const issues = getIssues(article);
        for (const { issue } of issues) {
          if (issue.問題) {
            items.push({
              id: `issue_${issue.問題}`,
              label: issue.問題,
              insertText: issue.問題,
              kind: 'issue',
              detail: issue.理由,
            });
          }
        }
      }
    }
  }

  // /gen
  if (trimmed === '/gen') {
    for (const [id, article] of articleDatabase.articles) {
      items.push({
        id: `gen_${id}`,
        label: `${article.名称 || id}のテンプレート`,
        insertText: generateTemplate(article),
        kind: 'template',
        detail: id,
      });
    }

    // スニペットも追加
    for (const [id, snippet] of snippets) {
      items.push({
        id: `snippet_${id}`,
        label: snippet.trigger,
        insertText: snippet.content,
        kind: 'template',
        detail: snippet.description,
      });
    }
  }

  return items;
}

function findCurrentClaim(content: string, targetLine: number): Claim | undefined {
  const parseResult = parse(content);
  const doc = parseResult.document;

  function searchClaim(nodes: any[]): Claim | undefined {
    for (const node of nodes) {
      if (node.type === 'Claim') {
        if (node.range.start.line <= targetLine && node.range.end.line >= targetLine) {
          return node as Claim;
        }
      } else if (node.type === 'Namespace') {
        const found = searchClaim(node.children);
        if (found) return found;
      }
    }
    return undefined;
  }

  return searchClaim(doc.children);
}

function applyCompletion(
  content: string,
  line: number,
  character: number,
  completionId: string
): string {
  const completions = getCompletions(content, line, character);
  const completion = completions.find(c => c.id === completionId);

  if (!completion) {
    return content;
  }

  const lines = content.split('\n');
  const currentLine = lines[line] || '';

  // 現在のトリガー文字を置換
  const textBeforeCursor = currentLine.substring(0, character);
  const trimmed = textBeforeCursor.trim();

  let replaceStart = character;
  if (trimmed === '*' || trimmed === '?' || trimmed === '#' || trimmed === '/gen') {
    replaceStart = textBeforeCursor.lastIndexOf(trimmed);
  }

  const newLine = currentLine.substring(0, replaceStart) + completion.insertText + currentLine.substring(character);
  lines[line] = newLine;

  return lines.join('\n');
}

// ===== テンプレート =====

function listTemplates(category?: string): TemplateInfo[] {
  const templates: TemplateInfo[] = [];

  for (const [id, article] of articleDatabase.articles) {
    // カテゴリをIDから推測（例：刑法235条 → 刑法）
    const match = id.match(/^([^\d]+)/);
    const cat = match ? match[1] : '不明';

    if (!category || cat.includes(category)) {
      templates.push({
        id,
        name: article.名称 || id,
        category: cat,
        description: article.原文?.substring(0, 50),
      });
    }
  }

  return templates;
}

function getTemplate(id: string): any {
  const article = findArticle(articleDatabase, id);
  if (!article) {
    return null;
  }

  const requirements = article.アノテーション
    .filter(a => a.種別 === '要件')
    .map(a => ({
      name: a.範囲 || a.name || '',
      norm: a.解釈?.[0]?.規範,
      required: a.必須 !== false,
      subRequirements: a.下位要件?.map(s => ({
        name: s.name,
        norm: s.規範,
      })),
    }));

  const issues = getIssues(article).map(({ issue, annotation }) => ({
    name: issue.問題,
    reason: issue.理由,
    norm: issue.解釈?.[0]?.規範,
    required: annotation.必須 !== false,
  }));

  return {
    id: article.id,
    name: article.名称,
    category: article.id.match(/^([^\d]+)/)?.[1] || '不明',
    sourceText: article.原文,
    requirements,
    issues,
  };
}

function searchTemplates(query: string): { id: string; name: string; relevance: number }[] {
  const results: { id: string; name: string; relevance: number }[] = [];
  const queryLower = query.toLowerCase();

  for (const [id, article] of articleDatabase.articles) {
    let relevance = 0;
    const name = article.名称 || id;
    const nameLower = name.toLowerCase();
    const idLower = id.toLowerCase();

    if (nameLower === queryLower || idLower === queryLower) {
      relevance = 1.0;
    } else if (nameLower.includes(queryLower) || idLower.includes(queryLower)) {
      relevance = 0.8;
    } else if (article.原文?.toLowerCase().includes(queryLower)) {
      relevance = 0.5;
    } else {
      // アノテーションも検索
      for (const annotation of article.アノテーション) {
        if (annotation.範囲?.toLowerCase().includes(queryLower) ||
            annotation.name?.toLowerCase().includes(queryLower)) {
          relevance = 0.3;
          break;
        }
      }
    }

    if (relevance > 0) {
      results.push({ id, name, relevance });
    }
  }

  return results.sort((a, b) => b.relevance - a.relevance);
}

function expandTemplate(templateId: string, subject?: string, facts?: string[]): string {
  const article = findArticle(articleDatabase, templateId);
  if (!article) {
    return `// テンプレート「${templateId}」が見つかりません`;
  }

  return generateTemplate(article, {
    fact: subject || '【事実を記載】',
    includeIssues: true,
    includeNorms: true,
  });
}

function registerTemplate(template: any): { success: boolean; message?: string } {
  const articleData: ArticleData = {
    id: template.id,
    名称: template.name,
    原文: template.sourceText || '',
    アノテーション: [],
  };

  // 要件を追加
  if (template.requirements) {
    for (const req of template.requirements) {
      articleData.アノテーション.push({
        範囲: req.name,
        種別: '要件',
        解釈: req.norm ? [{ 規範: req.norm }] : undefined,
        必須: req.required !== false,
      });
    }
  }

  // 論点を追加
  if (template.issues) {
    for (const issue of template.issues) {
      articleData.アノテーション.push({
        範囲: null,
        種別: '論点',
        name: issue.name,
        理由: issue.reason,
        解釈: issue.norm ? [{ 規範: issue.norm }] : undefined,
        必須: issue.required !== false,
      });
    }
  }

  articleDatabase.articles.set(template.id, articleData);
  if (template.name) {
    articleDatabase.nameIndex.set(template.name, template.id);
  }

  return { success: true, message: `テンプレート「${template.id}」を登録しました` };
}

function addToTemplate(
  templateId: string,
  type: 'requirement' | 'issue',
  name: string,
  norm?: string,
  reason?: string,
  required?: boolean
): { success: boolean; message?: string } {
  const article = findArticle(articleDatabase, templateId);
  if (!article) {
    return { success: false, message: `テンプレート「${templateId}」が見つかりません` };
  }

  if (type === 'requirement') {
    article.アノテーション.push({
      範囲: name,
      種別: '要件',
      解釈: norm ? [{ 規範: norm }] : undefined,
      必須: required !== false,
    });
  } else {
    article.アノテーション.push({
      範囲: null,
      種別: '論点',
      name,
      理由: reason,
      解釈: norm ? [{ 規範: norm }] : undefined,
      必須: required !== false,
    });
  }

  return { success: true, message: `「${name}」を追加しました` };
}

// ===== スニペット =====

function listSnippets(): SnippetInfo[] {
  return Array.from(snippets.values());
}

function registerSnippet(snippet: SnippetInfo): { success: boolean; message?: string } {
  snippets.set(snippet.id, snippet);
  return { success: true, message: `スニペット「${snippet.trigger}」を登録しました` };
}

// ===== MCPサーバー =====

const server = new Server(
  {
    name: 'houjicha-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ツール一覧
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// ツール実行
server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'houjicha_validate': {
        const result = validateContent(args.content as string);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'houjicha_get_completions': {
        const items = getCompletions(
          args.content as string,
          args.line as number,
          args.character as number
        );
        return { content: [{ type: 'text', text: JSON.stringify({ items }, null, 2) }] };
      }

      case 'houjicha_apply_completion': {
        const newContent = applyCompletion(
          args.content as string,
          args.line as number,
          args.character as number,
          args.completionId as string
        );
        return { content: [{ type: 'text', text: JSON.stringify({ newContent }, null, 2) }] };
      }

      case 'houjicha_list_templates': {
        const templates = listTemplates(args.category as string | undefined);
        return { content: [{ type: 'text', text: JSON.stringify({ templates }, null, 2) }] };
      }

      case 'houjicha_get_template': {
        const template = getTemplate(args.id as string);
        if (!template) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'テンプレートが見つかりません' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
      }

      case 'houjicha_search_templates': {
        const results = searchTemplates(args.query as string);
        return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
      }

      case 'houjicha_expand_template': {
        const content = expandTemplate(
          args.templateId as string,
          args.subject as string | undefined,
          args.facts as string[] | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify({ content }, null, 2) }] };
      }

      case 'houjicha_register_template': {
        const result = registerTemplate(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'houjicha_add_to_template': {
        const result = addToTemplate(
          args.templateId as string,
          args.type as 'requirement' | 'issue',
          args.name as string,
          args.norm as string | undefined,
          args.reason as string | undefined,
          args.required as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'houjicha_list_snippets': {
        const snippetList = listSnippets();
        return { content: [{ type: 'text', text: JSON.stringify({ snippets: snippetList }, null, 2) }] };
      }

      case 'houjicha_register_snippet': {
        const result = registerSnippet(args as SnippetInfo);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'houjicha_set_working_directory': {
        const dirPath = args.path as string;
        if (!fs.existsSync(dirPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'ディレクトリが存在しません' }) }] };
        }
        workingDirectory = dirPath;
        articleDatabase = loadArticleDatabase(dirPath);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `作業ディレクトリを設定しました: ${dirPath}`,
              templatesLoaded: articleDatabase.articles.size,
            }, null, 2),
          }],
        };
      }

      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: `不明なツール: ${name}` }) }] };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '不明なエラー';
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
  }
});

// サーバー起動
async function main() {
  // デフォルトで現在のディレクトリから条文データベースを読み込み
  try {
    articleDatabase = loadArticleDatabase(workingDirectory);
    console.error(`条文データベース読み込み完了: ${articleDatabase.articles.size}件`);
  } catch (e) {
    console.error(`条文データベース読み込みエラー: ${e}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ほうじ茶 MCP サーバーを起動しました');
}

main().catch(console.error);
