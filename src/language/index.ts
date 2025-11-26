/**
 * 本件 Matcha - 言語モジュール
 */

export * from './ast';
export * from './lexer';
export * from './parser';

// schema と loader は一部の型名が ast と競合するため、明示的にエクスポート
export {
  ArticleData,
  ArticleDatabase,
  Annotation,
  Interpretation,
  SubRequirement,
  LoadResult,
  RequirementCheck,
  TemplateOptions,
  GeneratedTemplate,
  getRequiredAnnotations,
  getIssues,
  getAllNorms,
  Issue as ArticleIssue,  // ast.Issue と区別
} from './schema';

export {
  loadArticleFromFile,
  findYamlFiles,
  loadArticleDatabase,
  findArticle,
  generateTemplate,
  ArticleDatabaseWatcher,
} from './loader';
