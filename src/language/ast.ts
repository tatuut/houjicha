/**
 * ほうじ茶（Houjicha）- 抽象構文木（AST）の型定義
 * 法的推論のための形式言語
 */

/** ソースコード上の位置情報 */
export interface Position {
  line: number;
  column: number;
  offset: number;
}

/** ソースコード上の範囲 */
export interface Range {
  start: Position;
  end: Position;
}

/** 全ASTノードの基底インターフェース */
export interface BaseNode {
  type: string;
  range: Range;
}

/** ドキュメント全体 */
export interface Document extends BaseNode {
  type: 'Document';
  children: (Namespace | Claim | Comment)[];
  constants: Map<string, ConstantDefinition>;
}

/** 論述空間（::甲の罪責） */
export interface Namespace extends BaseNode {
  type: 'Namespace';
  name: string;
  children: (Claim | Comment)[];
}

/** コメント */
export interface Comment extends BaseNode {
  type: 'Comment';
  text: string;
}

/**
 * 主張（#窃盗罪^刑法235条1項 <= 事実:）
 * - concluded: 結論（+該当/!否定/undefined未定）
 */
export interface Claim extends BaseNode {
  type: 'Claim';
  concluded: 'positive' | 'negative' | undefined;
  name: string;
  reference?: Reference;
  fact?: Fact;
  requirements: Requirement[];
  effect?: Effect;
  reasonStatements?: ReasonStatement[];
}

/** 根拠条文への参照（^刑法235条1項） */
export interface Reference extends BaseNode {
  type: 'Reference';
  citation: string;
}

/** 事実（<= の右側） */
export interface Fact extends BaseNode {
  type: 'Fact';
  content: string;
  evaluation?: Evaluation;
  operator?: 'and' | 'or';
  children?: Fact[];
}

/** 評価（@評価） */
export interface Evaluation extends BaseNode {
  type: 'Evaluation';
  content: string;
}

/**
 * 要件（「他人の財物」: %規範 <= 事実）
 * - concluded: 結論（+該当/!否定/undefined未定）
 */
export interface Requirement extends BaseNode {
  type: 'Requirement';
  concluded: 'positive' | 'negative' | undefined;
  name: string;
  norm?: Norm;
  fact?: Fact;
  subRequirements?: Requirement[];
  issue?: Issue;
  reasonStatements?: ReasonStatement[];
}

/**
 * 規範（%占有者の意思に反して）
 * - concluded: 結論（+該当/!否定/undefined未定）
 */
export interface Norm extends BaseNode {
  type: 'Norm';
  concluded: 'positive' | 'negative' | undefined;
  content: string;
  reference?: Reference;
  subNorm?: Norm;
  fact?: Fact;
  subRequirements?: Requirement[];
  constantDefinition?: string;  // as で定義した場合の定数名
  constantReference?: string;   // $ で参照した場合の定数名
}

/**
 * 論点（? 問題提起 ~> 理由 => %規範）
 */
export interface Issue extends BaseNode {
  type: 'Issue';
  question: string;
  reasons?: Reason[];
  norm: Norm;
  conclusion?: Conclusion;
}

/** 論点における理由 */
export interface Reason extends BaseNode {
  type: 'Reason';
  content: string;
  operator?: 'and' | 'or';
}

/** 結論 */
export interface Conclusion extends BaseNode {
  type: 'Conclusion';
  positive: boolean;
  content: string;
}

/** 効果（>> 甲に窃盗罪が成立する） */
export interface Effect extends BaseNode {
  type: 'Effect';
  content: string;
}

/** 独立行の理由（; 思考過程のメモ） */
export interface ReasonStatement extends BaseNode {
  type: 'ReasonStatement';
  content: string;
}

/** 定数定義（as 第三者の規範） */
export interface ConstantDefinition extends BaseNode {
  type: 'ConstantDefinition';
  name: string;
  value: Norm;
}

/** 定数参照（$第三者の規範） */
export interface ConstantReference extends BaseNode {
  type: 'ConstantReference';
  name: string;
}

/** 全ノード型のユニオン */
export type ASTNode =
  | Document
  | Namespace
  | Comment
  | Claim
  | Reference
  | Fact
  | Evaluation
  | Requirement
  | Norm
  | Issue
  | Reason
  | Conclusion
  | Effect
  | ReasonStatement
  | ConstantDefinition
  | ConstantReference;

/** ノード型を判別するタイプガード */
export function isDocument(node: ASTNode): node is Document {
  return node.type === 'Document';
}

export function isNamespace(node: ASTNode): node is Namespace {
  return node.type === 'Namespace';
}

export function isClaim(node: ASTNode): node is Claim {
  return node.type === 'Claim';
}

export function isRequirement(node: ASTNode): node is Requirement {
  return node.type === 'Requirement';
}

export function isNorm(node: ASTNode): node is Norm {
  return node.type === 'Norm';
}

export function isIssue(node: ASTNode): node is Issue {
  return node.type === 'Issue';
}

export function isFact(node: ASTNode): node is Fact {
  return node.type === 'Fact';
}
