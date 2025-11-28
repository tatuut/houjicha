/**
 * Chai - 条文データローダー
 * YAMLファイルから条文データを読み込む
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  ArticleData,
  ArticleDatabase,
  LoadResult,
  Annotation,
  getRequiredAnnotations,
  getIssues,
  getAllNorms,
} from './schema';

// Re-export types
export { ArticleData, ArticleDatabase, LoadResult, Annotation };

/** YAMLファイルを読み込んで条文データを取得 */
export function loadArticleFromFile(filePath: string): LoadResult {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = yaml.load(content) as ArticleData;

    // バリデーション
    if (!data.id) {
      return { success: false, error: 'idが必要です', filePath };
    }
    if (!data.原文) {
      return { success: false, error: '原文が必要です', filePath };
    }
    if (!data.アノテーション || !Array.isArray(data.アノテーション)) {
      return { success: false, error: 'アノテーションが必要です', filePath };
    }

    return { success: true, data, filePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : '不明なエラー';
    return { success: false, error: message, filePath };
  }
}

/** ディレクトリを再帰的にスキャンしてYAMLファイルを検索 */
export function findYamlFiles(dirPath: string): string[] {
  const results: string[] = [];

  function scan(currentPath: string): void {
    if (!fs.existsSync(currentPath)) return;

    const stat = fs.statSync(currentPath);
    if (stat.isFile() && (currentPath.endsWith('.yaml') || currentPath.endsWith('.yml'))) {
      results.push(currentPath);
    } else if (stat.isDirectory()) {
      // node_modules と . で始まるディレクトリはスキップ
      const basename = path.basename(currentPath);
      if (basename === 'node_modules' || basename.startsWith('.')) {
        return;
      }

      const entries = fs.readdirSync(currentPath);
      for (const entry of entries) {
        scan(path.join(currentPath, entry));
      }
    }
  }

  scan(dirPath);
  return results;
}

/** ディレクトリから全ての条文データを読み込んでデータベースを構築 */
export function loadArticleDatabase(rootDir: string): ArticleDatabase {
  const database: ArticleDatabase = {
    articles: new Map(),
    nameIndex: new Map(),
  };

  const yamlFiles = findYamlFiles(rootDir);

  for (const filePath of yamlFiles) {
    const result = loadArticleFromFile(filePath);
    if (result.success && result.data) {
      const article = result.data;
      database.articles.set(article.id, article);

      // 名称でも引けるようにインデックス
      if (article.名称) {
        database.nameIndex.set(article.名称, article.id);
      }

      // idから罪名を推測してインデックス（例：刑法235条 → 窃盗罪）
      // ファイル名からも推測（例：235_窃盗.yaml → 窃盗）
      const fileName = path.basename(filePath, path.extname(filePath));
      const match = fileName.match(/^\d+_(.+)$/);
      if (match) {
        database.nameIndex.set(match[1], article.id);
        database.nameIndex.set(match[1] + '罪', article.id);
      }
    }
  }

  return database;
}

/** 条文を検索（ID、名称、部分一致） */
export function findArticle(
  database: ArticleDatabase,
  query: string
): ArticleData | undefined {
  // 完全一致（ID）
  if (database.articles.has(query)) {
    return database.articles.get(query);
  }

  // 完全一致（名称）
  const idByName = database.nameIndex.get(query);
  if (idByName) {
    return database.articles.get(idByName);
  }

  // 部分一致
  for (const [id, article] of database.articles) {
    if (id.includes(query) || article.名称?.includes(query)) {
      return article;
    }
  }

  return undefined;
}

/** 条文データからMatchaテンプレートを生成 */
export function generateTemplate(
  article: ArticleData,
  options: {
    fact?: string;
    includeIssues?: boolean;
    includeNorms?: boolean;
    indent?: string;
  } = {}
): string {
  const {
    fact = '【事実を記載】',
    includeIssues = true,
    includeNorms = true,
    indent = '    ',
  } = options;

  const lines: string[] = [];

  // 主張行
  lines.push(`#${article.名称 || article.id}^${article.id} <= ${fact}:`);

  // アノテーションから要件を生成
  for (const annotation of article.アノテーション) {
    if (annotation.種別 === '要件' && annotation.範囲) {
      // 要件行
      let reqLine = `${indent}*${annotation.範囲}`;

      // 規範を追加
      if (includeNorms && annotation.解釈 && annotation.解釈.length > 0) {
        reqLine += `: %${annotation.解釈[0].規範}`;
      }

      reqLine += ' <= 【あてはめ】';
      lines.push(reqLine);

      // 下位要件
      if (annotation.下位要件) {
        for (const sub of annotation.下位要件) {
          let subLine = `${indent}${indent}%${sub.name}`;
          if (includeNorms && sub.規範) {
            subLine += `: %${sub.規範}`;
          }
          subLine += ' <= 【あてはめ】';
          lines.push(subLine);
        }
      }
    }

    // 論点（条文に明示されない要件）
    if (annotation.種別 === '論点' && includeIssues) {
      const name = annotation.name || '';
      let issueLine = `${indent}? ${annotation.理由 || '【問題提起】'} => ${name}`;

      if (annotation.解釈 && annotation.解釈.length > 0) {
        issueLine = `${indent}? ${annotation.理由 || '【問題提起】'} => %${annotation.解釈[0].規範}`;
      }

      lines.push(issueLine);

      // 論点の下位要件
      if (annotation.下位要件) {
        for (const sub of annotation.下位要件) {
          lines.push(`${indent}${indent}%${sub.name} <= 【あてはめ】`);
        }
      }
    }
  }

  // 効果
  lines.push(`>> 【結論を記載】`);

  return lines.join('\n');
}

/** 条文データベースをウォッチして変更を監視 */
export class ArticleDatabaseWatcher {
  private database: ArticleDatabase;
  private watchers: fs.FSWatcher[] = [];
  private onChange: (database: ArticleDatabase) => void;

  constructor(
    private rootDir: string,
    onChange: (database: ArticleDatabase) => void
  ) {
    this.onChange = onChange;
    this.database = loadArticleDatabase(rootDir);
  }

  /** データベースを取得 */
  getDatabase(): ArticleDatabase {
    return this.database;
  }

  /** 監視を開始 */
  start(): void {
    this.watchDirectory(this.rootDir);
  }

  /** 監視を停止 */
  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private watchDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;

    const watcher = fs.watch(dirPath, { recursive: true }, (event, filename) => {
      if (filename && (filename.endsWith('.yaml') || filename.endsWith('.yml'))) {
        // デバウンス処理（短時間に複数回呼ばれることがある）
        setTimeout(() => {
          this.database = loadArticleDatabase(this.rootDir);
          this.onChange(this.database);
        }, 100);
      }
    });

    this.watchers.push(watcher);
  }

  /** データベースをリロード */
  reload(): void {
    this.database = loadArticleDatabase(this.rootDir);
    this.onChange(this.database);
  }
}

// エクスポート
export { getRequiredAnnotations, getIssues, getAllNorms };
