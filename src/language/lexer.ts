/**
 * ほうじ茶（Houjicha）- 字句解析器（Lexer）
 * 日本語IME対応のため、全角記号も認識する
 */

import { Position, Range } from './ast';

/** トークンの種類 */
export enum TokenType {
  // 構文記号
  HASH = 'HASH',                     // # 主張
  CARET = 'CARET',                   // ^ 根拠条文参照
  COLON = 'COLON',                   // : 言い換え
  DOUBLE_COLON = 'DOUBLE_COLON',     // :: 論述空間
  ARROW_LEFT = 'ARROW_LEFT',         // <= あてはめ
  ARROW_RIGHT = 'ARROW_RIGHT',       // >> 効果
  QUESTION = 'QUESTION',             // ? 論点
  PERCENT = 'PERCENT',               // % 規範
  AT = 'AT',                         // @ 評価
  TILDE_ARROW = 'TILDE_ARROW',       // ~> 理由（論点内）
  IMPLIES = 'IMPLIES',               // => 帰結
  SEMICOLON = 'SEMICOLON',           // ; 理由（独立行）

  // 論理演算子
  AND = 'AND',                       // & または ＆
  OR = 'OR',                         // | または ｜

  // 結論マーカー
  PLUS = 'PLUS',                     // + 該当
  EXCLAIM = 'EXCLAIM',               // ! 否定

  // 括弧類
  LPAREN = 'LPAREN',                 // ( または （
  RPAREN = 'RPAREN',                 // ) または ）
  LBRACKET_JP = 'LBRACKET_JP',       // 「 (後方互換)
  RBRACKET_JP = 'RBRACKET_JP',       // 」 (後方互換)
  ASTERISK = 'ASTERISK',             // * 要件マーカー

  // キーワード
  AS = 'AS',                         // as 定数定義

  // リテラル
  DOLLAR = 'DOLLAR',                 // $ 定数参照
  TEXT = 'TEXT',                     // 一般テキスト
  IDENTIFIER = 'IDENTIFIER',         // 識別子

  // その他
  NEWLINE = 'NEWLINE',               // 改行
  INDENT = 'INDENT',                 // インデント
  DEDENT = 'DEDENT',                 // デデント
  COMMENT = 'COMMENT',               // コメント
  EOF = 'EOF',                       // ファイル終端
  ERROR = 'ERROR',                   // エラートークン
}

/** トークン */
export interface Token {
  type: TokenType;
  value: string;
  range: Range;
}

/** 字句解析エラー */
export interface LexerError {
  message: string;
  range: Range;
}

/** 字句解析器 */
export class Lexer {
  private source: string;
  private pos: number = 0;
  private line: number = 0;
  private column: number = 0;
  private tokens: Token[] = [];
  private errors: LexerError[] = [];
  private indentStack: number[] = [0];
  private atLineStart: boolean = true;

  constructor(source: string) {
    this.source = source;
  }

  /** 字句解析を実行 */
  tokenize(): { tokens: Token[]; errors: LexerError[] } {
    while (!this.isAtEnd()) {
      this.scanToken();
    }

    // 残りのDEDENTを追加
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.addToken(TokenType.DEDENT, '');
    }

    this.addToken(TokenType.EOF, '');
    return { tokens: this.tokens, errors: this.errors };
  }

  private isAtEnd(): boolean {
    return this.pos >= this.source.length;
  }

  private peek(offset: number = 0): string {
    const idx = this.pos + offset;
    return idx < this.source.length ? this.source[idx] : '\0';
  }

  private advance(): string {
    const char = this.source[this.pos];
    this.pos++;
    if (char === '\n') {
      this.line++;
      this.column = 0;
      this.atLineStart = true;
    } else {
      this.column++;
    }
    return char;
  }

  private createPosition(): Position {
    return { line: this.line, column: this.column, offset: this.pos };
  }

  private addToken(type: TokenType, value: string, startPos?: Position): void {
    const start = startPos || this.createPosition();
    const end = this.createPosition();
    this.tokens.push({ type, value, range: { start, end } });
  }

  private addError(message: string, startPos?: Position): void {
    const start = startPos || this.createPosition();
    const end = this.createPosition();
    this.errors.push({ message, range: { start, end } });
  }

  private scanToken(): void {
    // 行頭のインデント処理
    if (this.atLineStart) {
      this.handleIndentation();
      return;
    }

    const startPos = this.createPosition();
    const char = this.advance();

    switch (char) {
      // 空白をスキップ（行頭以外）
      case ' ':
      case '\t':
      case '\u3000': // 全角スペース
        break;

      // 改行
      case '\n':
        this.addToken(TokenType.NEWLINE, '\n', startPos);
        break;

      case '\r':
        if (this.peek() === '\n') this.advance();
        this.addToken(TokenType.NEWLINE, '\n', startPos);
        break;

      // コメント
      case '/':
        if (this.peek() === '/') {
          this.advance();
          this.scanComment(startPos);
        } else {
          this.addError(`予期しない文字: ${char}`, startPos);
        }
        break;

      // 記号（半角）
      case '#':
      case '＃':
        this.addToken(TokenType.HASH, char, startPos);
        break;

      case '^':
        this.addToken(TokenType.CARET, char, startPos);
        break;

      case ':':
        if (this.peek() === ':') {
          this.advance();
          this.addToken(TokenType.DOUBLE_COLON, '::', startPos);
        } else {
          this.addToken(TokenType.COLON, ':', startPos);
        }
        break;

      case '：':
        if (this.peek() === '：') {
          this.advance();
          this.addToken(TokenType.DOUBLE_COLON, '：：', startPos);
        } else {
          this.addToken(TokenType.COLON, '：', startPos);
        }
        break;

      case '<':
        if (this.peek() === '=') {
          this.advance();
          this.addToken(TokenType.ARROW_LEFT, '<=', startPos);
        } else {
          this.scanText(startPos, char);
        }
        break;

      case '>':
        if (this.peek() === '>') {
          this.advance();
          this.addToken(TokenType.ARROW_RIGHT, '>>', startPos);
        } else {
          this.scanText(startPos, char);
        }
        break;

      case '?':
      case '？':
        this.addToken(TokenType.QUESTION, char, startPos);
        break;

      case '%':
      case '％':
        this.addToken(TokenType.PERCENT, char, startPos);
        break;

      case '@':
      case '＠':
        this.addToken(TokenType.AT, char, startPos);
        break;

      case ';':
      case '；':
        this.addToken(TokenType.SEMICOLON, char, startPos);
        break;

      case '~':
        if (this.peek() === '>') {
          this.advance();
          this.addToken(TokenType.TILDE_ARROW, '~>', startPos);
        } else {
          this.scanText(startPos, char);
        }
        break;

      case '=':
        if (this.peek() === '>') {
          this.advance();
          this.addToken(TokenType.IMPLIES, '=>', startPos);
        } else {
          this.scanText(startPos, char);
        }
        break;

      case '&':
      case '＆':
        this.addToken(TokenType.AND, char, startPos);
        break;

      case '|':
      case '｜':
        this.addToken(TokenType.OR, char, startPos);
        break;

      case '+':
      case '＋':
        this.addToken(TokenType.PLUS, char, startPos);
        break;

      case '!':
      case '！':
        this.addToken(TokenType.EXCLAIM, char, startPos);
        break;

      case '(':
      case '（':
        this.addToken(TokenType.LPAREN, char, startPos);
        break;

      case ')':
      case '）':
        this.addToken(TokenType.RPAREN, char, startPos);
        break;

      case '「':
        this.addToken(TokenType.LBRACKET_JP, char, startPos);
        break;

      case '」':
        this.addToken(TokenType.RBRACKET_JP, char, startPos);
        break;

      case '*':
      case '＊':
        this.addToken(TokenType.ASTERISK, char, startPos);
        break;

      case '$':
      case '＄':
        this.addToken(TokenType.DOLLAR, char, startPos);
        break;

      case '\\':
        // バックスラッシュの後の文字をエスケープとして扱う
        if (!this.isAtEnd()) {
          const escaped = this.advance();
          if (escaped === '&') {
            this.addToken(TokenType.AND, '\\&', startPos);
          } else {
            this.scanText(startPos, char + escaped);
          }
        }
        break;

      default:
        this.scanText(startPos, char);
        break;
    }
  }

  /** インデント処理 */
  private handleIndentation(): void {
    let indent = 0;
    const startPos = this.createPosition();

    while (!this.isAtEnd()) {
      const char = this.peek();
      if (char === ' ') {
        indent++;
        this.advance();
      } else if (char === '\t') {
        indent += 4; // タブは4スペース換算
        this.advance();
      } else if (char === '\u3000') {
        indent += 2; // 全角スペースは2スペース換算
        this.advance();
      } else {
        break;
      }
    }

    this.atLineStart = false;

    // 空行のみインデント処理をスキップ（コメント行はインデント処理を行う）
    if (this.peek() === '\n' || this.peek() === '\r') {
      return;
    }

    const currentIndent = this.indentStack[this.indentStack.length - 1];

    if (indent > currentIndent) {
      this.indentStack.push(indent);
      this.addToken(TokenType.INDENT, '', startPos);
    } else if (indent < currentIndent) {
      while (this.indentStack.length > 1 &&
             this.indentStack[this.indentStack.length - 1] > indent) {
        this.indentStack.pop();
        this.addToken(TokenType.DEDENT, '', startPos);
      }
    }
  }

  /** コメントをスキャン */
  private scanComment(startPos: Position): void {
    let text = '';
    while (!this.isAtEnd() && this.peek() !== '\n') {
      text += this.advance();
    }
    this.addToken(TokenType.COMMENT, text.trim(), startPos);
  }

  /** テキストをスキャン（識別子や一般テキスト） */
  private scanText(startPos: Position, initial: string): void {
    let text = initial;

    // 特殊文字以外を読み続ける
    while (!this.isAtEnd()) {
      const char = this.peek();
      if (this.isSpecialChar(char) || char === '\n' || char === '\r') {
        break;
      }
      text += this.advance();
    }

    // "as" キーワードのチェック
    const trimmed = text.trim();
    if (trimmed === 'as') {
      this.addToken(TokenType.AS, trimmed, startPos);
    } else if (trimmed.length > 0) {
      this.addToken(TokenType.TEXT, trimmed, startPos);
    }
  }

  /** 特殊文字かどうか判定 */
  private isSpecialChar(char: string): boolean {
    const specialChars = [
      '#', '＃', '^', ':', '：', '<', '>', '?', '？',
      '%', '％', '@', '＠', '~', '=', '&', '＆', '|', '｜',
      '+', '＋', '!', '！', '(', '（', ')', '）',
      '「', '」', '$', '＄', '/', '\\', ';', '；',
      '*', '＊',  // 要件マーカー
      ' ', '\t', '\u3000'
    ];
    return specialChars.includes(char);
  }

  /** 識別子の開始文字かどうか */
  private isIdentifierStart(char: string): boolean {
    return /[\p{L}_]/u.test(char);
  }

  /** 識別子の継続文字かどうか */
  private isIdentifierPart(char: string): boolean {
    return /[\p{L}\p{N}_]/u.test(char);
  }
}

/** 便利な字句解析関数 */
export function tokenize(source: string): { tokens: Token[]; errors: LexerError[] } {
  const lexer = new Lexer(source);
  return lexer.tokenize();
}
