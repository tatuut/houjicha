/**
 * 本件 Matcha - 条文データスキーマ
 * YAMLで定義される条文・要件・論点の型定義
 */

/** 解釈（規範の定義） */
export interface Interpretation {
  /** 規範の内容 */
  規範: string;
  /** 出典（判例、通説、学説名など） */
  出典?: string;
  /** 補足説明 */
  説明?: string;
}

/** 論点 */
export interface Issue {
  /** 問題提起 */
  問題: string;
  /** 理由（なぜ論点になるか） */
  理由?: string;
  /** 複数の解釈（判例・学説の対立など） */
  解釈: Interpretation[];
}

/** 下位要件 */
export interface SubRequirement {
  /** 要件名 */
  name: string;
  /** 規範 */
  規範?: string;
  /** この要件に関する論点 */
  論点?: Issue[];
  /** さらなる下位要件 */
  下位要件?: SubRequirement[];
}

/** 条文テキストへのアノテーション */
export interface Annotation {
  /** 条文中の対象範囲（テキスト）。nullの場合は条文に明示されない要件 */
  範囲: string | null;
  /** アノテーションの種別 */
  種別: '要件' | '論点' | '効果';
  /** 論点の場合の名前（範囲がnullの場合に使用） */
  name?: string;
  /** この範囲の解釈 */
  解釈?: Interpretation[];
  /** この範囲に関する論点 */
  論点?: Issue[];
  /** 下位要件 */
  下位要件?: SubRequirement[];
  /** 論点になる理由（種別が論点の場合） */
  理由?: string;
  /** 必須かどうか（デフォルトtrue） */
  必須?: boolean;
}

/** 条文データ */
export interface ArticleData {
  /** 条文ID（例：刑法235条） */
  id: string;
  /** 条文の原文 */
  原文: string;
  /** 罪名・制度名など */
  名称?: string;
  /** アノテーション */
  アノテーション: Annotation[];
  /** 関連条文 */
  関連?: string[];
}

/** 条文データベース（複数の条文を管理） */
export interface ArticleDatabase {
  /** 条文ID -> ArticleData のマップ */
  articles: Map<string, ArticleData>;
  /** 名称 -> 条文ID のマップ（逆引き用） */
  nameIndex: Map<string, string>;
}

/** YAML読み込み結果 */
export interface LoadResult {
  success: boolean;
  data?: ArticleData;
  error?: string;
  filePath: string;
}

/** 要件チェック結果 */
export interface RequirementCheck {
  /** 要件名 */
  name: string;
  /** 検討済みかどうか */
  checked: boolean;
  /** 必須かどうか */
  required: boolean;
  /** 規範の候補 */
  norms: Interpretation[];
  /** 関連する論点 */
  issues: Issue[];
}

/** テンプレート生成オプション */
export interface TemplateOptions {
  /** 条文ID */
  articleId: string;
  /** 事実（あてはめ対象） */
  fact?: string;
  /** 論点を含めるか */
  includeIssues?: boolean;
  /** 規範を含めるか */
  includeNorms?: boolean;
  /** インデント文字 */
  indent?: string;
}

/** 生成されたテンプレート */
export interface GeneratedTemplate {
  /** Matchaコード */
  code: string;
  /** 検討すべき要件のリスト */
  requirements: string[];
  /** 検討すべき論点のリスト */
  issues: string[];
}

// ===== ユーティリティ関数 =====

/** 条文データから必須要件を抽出 */
export function getRequiredAnnotations(article: ArticleData): Annotation[] {
  return article.アノテーション.filter(a => a.必須 !== false);
}

/** 条文データから論点を抽出 */
export function getIssues(article: ArticleData): { annotation: Annotation; issue: Issue }[] {
  const results: { annotation: Annotation; issue: Issue }[] = [];

  for (const annotation of article.アノテーション) {
    // 種別が論点のもの
    if (annotation.種別 === '論点' && annotation.解釈) {
      results.push({
        annotation,
        issue: {
          問題: annotation.name || annotation.範囲 || '',
          理由: annotation.理由,
          解釈: annotation.解釈,
        },
      });
    }

    // 要件に付随する論点
    if (annotation.論点) {
      for (const issue of annotation.論点) {
        results.push({ annotation, issue });
      }
    }
  }

  return results;
}

/** 条文データから全ての規範を抽出 */
export function getAllNorms(article: ArticleData): { context: string; norm: Interpretation }[] {
  const results: { context: string; norm: Interpretation }[] = [];

  function extractFromAnnotation(annotation: Annotation, context: string): void {
    if (annotation.解釈) {
      for (const interp of annotation.解釈) {
        results.push({ context, norm: interp });
      }
    }
    if (annotation.論点) {
      for (const issue of annotation.論点) {
        for (const interp of issue.解釈) {
          results.push({ context: `${context}（${issue.問題}）`, norm: interp });
        }
      }
    }
    if (annotation.下位要件) {
      for (const sub of annotation.下位要件) {
        extractFromSubRequirement(sub, context);
      }
    }
  }

  function extractFromSubRequirement(sub: SubRequirement, parentContext: string): void {
    const context = `${parentContext} > ${sub.name}`;
    if (sub.規範) {
      results.push({ context, norm: { 規範: sub.規範 } });
    }
    if (sub.論点) {
      for (const issue of sub.論点) {
        for (const interp of issue.解釈) {
          results.push({ context: `${context}（${issue.問題}）`, norm: interp });
        }
      }
    }
    if (sub.下位要件) {
      for (const child of sub.下位要件) {
        extractFromSubRequirement(child, context);
      }
    }
  }

  for (const annotation of article.アノテーション) {
    const context = annotation.範囲 || annotation.name || '';
    extractFromAnnotation(annotation, context);
  }

  return results;
}
