/**
 * ほうじ茶（Houjicha）- 構文解析器（Parser）
 */

import {
  Document, Namespace, Claim, Requirement, Norm, Fact, Evaluation,
  Issue, Reason, Effect, Reference, Comment, ConstantDefinition,
  ReasonStatement, Range, Position, ASTNode
} from './ast';
import { Token, TokenType, tokenize, LexerError } from './lexer';

/** 構文解析エラー */
export interface ParseError {
  message: string;
  range: Range;
}

/** 構文解析結果 */
export interface ParseResult {
  document: Document;
  errors: ParseError[];
}

/** 構文解析器 */
export class Parser {
  private tokens: Token[] = [];
  private pos: number = 0;
  private errors: ParseError[] = [];
  private constants: Map<string, ConstantDefinition> = new Map();

  constructor(private source: string) {}

  /** 構文解析を実行 */
  parse(): ParseResult {
    const { tokens, errors: lexerErrors } = tokenize(this.source);
    this.tokens = tokens;
    this.errors = lexerErrors.map(e => ({
      message: e.message,
      range: e.range
    }));

    const document = this.parseDocument();
    return { document, errors: this.errors };
  }

  // ===== ユーティリティメソッド =====

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private peek(offset: number = 0): Token {
    const idx = this.pos + offset;
    return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.pos++;
    return this.tokens[this.pos - 1];
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private expect(type: TokenType, message: string): Token {
    if (this.check(type)) {
      return this.advance();
    }
    this.addError(message);
    return this.peek();
  }

  private addError(message: string, range?: Range): void {
    const r = range || this.peek().range;
    this.errors.push({ message, range: r });
  }

  private skipNewlines(): void {
    while (this.match(TokenType.NEWLINE)) {}
  }

  private createRange(start: Position, end: Position): Range {
    return { start, end };
  }

  // ===== ドキュメント解析 =====

  private parseDocument(): Document {
    const startPos = this.peek().range.start;
    const children: (Namespace | Claim | Comment)[] = [];

    this.skipNewlines();

    while (!this.isAtEnd()) {
      if (this.check(TokenType.DOUBLE_COLON)) {
        children.push(this.parseNamespace());
      } else if (this.check(TokenType.COMMENT)) {
        children.push(this.parseComment());
      } else if (this.check(TokenType.HASH) ||
                 this.check(TokenType.PLUS) ||
                 this.check(TokenType.EXCLAIM)) {
        children.push(this.parseClaim());
      } else if (this.check(TokenType.NEWLINE)) {
        this.advance();
      } else if (this.check(TokenType.SEMICOLON)) {
        // トップレベルの理由文はスキップ（Claimに属さない）
        this.parseReasonStatement();
      } else if (this.check(TokenType.INDENT)) {
        // 孤立したインデント（主張の外にある要件など）
        this.addError('インデントされた内容は主張（#）または名前空間（::）の内部に記述してください');
        this.skipOrphanedIndentedBlock();
      } else if (this.check(TokenType.LPAREN)) {
        // トップレベルの()は許可されない
        this.addError('要件()は主張（#）の内部に記述してください');
        this.skipUntilNewline();
      } else if (this.check(TokenType.PERCENT)) {
        // トップレベルの%は許可されない
        this.addError('規範（%）は主張（#）の内部に記述してください');
        this.skipUntilNewline();
      } else if (this.check(TokenType.QUESTION)) {
        // トップレベルの?は許可されない
        this.addError('論点（?）は主張（#）の内部に記述してください');
        this.skipUntilNewline();
      } else if (this.check(TokenType.ARROW_RIGHT)) {
        // トップレベルの>>は許可されない
        this.addError('効果（>>）は主張（#）の後に記述してください');
        this.skipUntilNewline();
      } else {
        this.addError(`予期しないトークン: ${this.peek().type}`);
        this.advance();
      }
    }

    const endPos = this.peek().range.end;
    return {
      type: 'Document',
      children,
      constants: this.constants,
      range: this.createRange(startPos, endPos)
    };
  }

  // 孤立したインデントブロックをスキップ
  private skipOrphanedIndentedBlock(): void {
    this.advance(); // INDENT
    let depth = 1;
    while (!this.isAtEnd() && depth > 0) {
      if (this.check(TokenType.INDENT)) {
        depth++;
      } else if (this.check(TokenType.DEDENT)) {
        depth--;
      }
      this.advance();
    }
  }

  // 行末までスキップ
  private skipUntilNewline(): void {
    while (!this.isAtEnd() && !this.check(TokenType.NEWLINE)) {
      this.advance();
    }
    if (this.check(TokenType.NEWLINE)) {
      this.advance();
    }
  }

  // ===== 論述空間（Namespace）解析 =====

  private parseNamespace(): Namespace {
    const startToken = this.advance(); // ::
    const startPos = startToken.range.start;

    let name = '';
    while (!this.isAtEnd() && !this.check(TokenType.NEWLINE)) {
      name += this.advance().value + ' ';
    }
    name = name.trim();

    this.skipNewlines();

    const children: (Claim | Comment)[] = [];

    // インデントされた内容を解析
    if (this.check(TokenType.INDENT)) {
      this.advance();

      while (!this.isAtEnd() && !this.check(TokenType.DEDENT)) {
        if (this.check(TokenType.COMMENT)) {
          children.push(this.parseComment());
        } else if (this.check(TokenType.HASH) ||
                   this.check(TokenType.PLUS) ||
                   this.check(TokenType.EXCLAIM)) {
          children.push(this.parseClaim());
        } else if (this.check(TokenType.NEWLINE)) {
          this.advance();
        } else {
          break;
        }
      }

      if (this.check(TokenType.DEDENT)) {
        this.advance();
      }
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Namespace',
      name,
      children,
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== コメント解析 =====

  private parseComment(): Comment {
    const token = this.advance();
    return {
      type: 'Comment',
      text: token.value,
      range: token.range
    };
  }

  // ===== 理由文（; ）解析 =====

  private parseReasonStatement(): ReasonStatement {
    const startPos = this.peek().range.start;
    this.advance(); // ; を消費

    let content = '';
    while (!this.isAtEnd() && !this.check(TokenType.NEWLINE)) {
      content += this.advance().value + ' ';
    }

    const endPos = this.peek().range.start;
    return {
      type: 'ReasonStatement',
      content: content.trim(),
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 主張（Claim）解析 =====

  private parseClaim(): Claim {
    const startPos = this.peek().range.start;
    let concluded: 'positive' | 'negative' | undefined;

    // 結論マーカーをチェック
    if (this.match(TokenType.PLUS)) {
      concluded = 'positive';
    } else if (this.match(TokenType.EXCLAIM)) {
      concluded = 'negative';
    }

    this.expect(TokenType.HASH, '主張には # が必要です');

    // 主張名を取得
    let name = '';
    while (!this.isAtEnd() &&
           !this.check(TokenType.CARET) &&
           !this.check(TokenType.ARROW_LEFT) &&
           !this.check(TokenType.COLON) &&
           !this.check(TokenType.NEWLINE)) {
      name += this.advance().value + ' ';
    }
    name = name.trim();

    // 根拠条文参照
    let reference: Reference | undefined;
    if (this.match(TokenType.CARET)) {
      reference = this.parseReference();
    }

    // 事実へのあてはめ
    let fact: Fact | undefined;
    if (this.match(TokenType.ARROW_LEFT)) {
      fact = this.parseFact();
    }

    // 要件がある場合（: で終わる）
    const requirements: Requirement[] = [];
    const reasonStatements: ReasonStatement[] = [];
    let effect: Effect | undefined;

    const hasRequirements = this.match(TokenType.COLON);
    this.skipNewlines();

    if (hasRequirements && this.check(TokenType.INDENT)) {
      this.advance();

      while (!this.isAtEnd() && !this.check(TokenType.DEDENT)) {
        if (this.check(TokenType.LPAREN)) {
          requirements.push(this.parseRequirement());
        } else if (this.check(TokenType.PERCENT) ||
                   this.check(TokenType.DOLLAR) ||
                   (this.check(TokenType.PLUS) && (this.peek(1).type === TokenType.PERCENT || this.peek(1).type === TokenType.DOLLAR)) ||
                   (this.check(TokenType.PLUS) && this.peek(1).type === TokenType.LPAREN) ||
                   (this.check(TokenType.EXCLAIM) && (this.peek(1).type === TokenType.PERCENT || this.peek(1).type === TokenType.DOLLAR)) ||
                   (this.check(TokenType.EXCLAIM) && this.peek(1).type === TokenType.LPAREN)) {
          // +% or !% or +( or !( or +$ or !$ or $ or %
          if (this.peek(1).type === TokenType.LPAREN) {
            requirements.push(this.parseRequirement());
          } else {
            requirements.push(this.parseNormAsRequirement());
          }
        } else if (this.check(TokenType.PLUS) || this.check(TokenType.EXCLAIM)) {
          // 単独の + or ! の後に % か $ か ( が来る場合
          requirements.push(this.parseNormAsRequirement());
        } else if (this.check(TokenType.QUESTION)) {
          requirements.push(this.parseIssueAsRequirement());
        } else if (this.check(TokenType.ARROW_RIGHT)) {
          effect = this.parseEffect();
        } else if (this.check(TokenType.SEMICOLON)) {
          reasonStatements.push(this.parseReasonStatement());
        } else if (this.check(TokenType.NEWLINE)) {
          this.advance();
        } else if (this.check(TokenType.COMMENT)) {
          this.advance(); // コメントをスキップ
        } else {
          break;
        }
      }

      if (this.check(TokenType.DEDENT)) {
        this.advance();
      }
    }

    // インデント外の効果
    if (this.check(TokenType.ARROW_RIGHT)) {
      effect = this.parseEffect();
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Claim',
      concluded,
      name,
      reference,
      fact,
      requirements,
      effect,
      reasonStatements: reasonStatements.length > 0 ? reasonStatements : undefined,
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 根拠条文参照解析 =====

  private parseReference(): Reference {
    const startPos = this.peek().range.start;
    let citation = '';

    while (!this.isAtEnd() &&
           !this.check(TokenType.ARROW_LEFT) &&
           !this.check(TokenType.COLON) &&
           !this.check(TokenType.NEWLINE)) {
      citation += this.advance().value + ' ';
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Reference',
      citation: citation.trim(),
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 事実解析（複数@対応） =====

  private parseFact(): Fact {
    const startPos = this.peek().range.start;

    // 括弧で囲まれた複合事実
    if (this.match(TokenType.LPAREN)) {
      return this.parseCompoundFact(startPos);
    }

    // 単一事実（複数@対応）
    let content = '';
    const evaluations: Evaluation[] = [];

    while (!this.isAtEnd() &&
           !this.check(TokenType.COLON) &&
           !this.check(TokenType.AND) &&
           !this.check(TokenType.OR) &&
           !this.check(TokenType.RPAREN) &&
           !this.check(TokenType.ARROW_RIGHT) &&
           !this.check(TokenType.SEMICOLON) &&
           !this.check(TokenType.NEWLINE)) {

      if (this.check(TokenType.AT)) {
        this.advance();
        evaluations.push(this.parseEvaluation());
        // @の後に更にテキストが続く可能性がある
        continue;
      }

      content += this.advance().value + ' ';
    }

    const endPos = this.peek().range.start;

    // 最初の評価をmain evaluationとして使用（後方互換性）
    const mainEvaluation = evaluations.length > 0 ? evaluations[0] : undefined;

    return {
      type: 'Fact',
      content: content.trim(),
      evaluation: mainEvaluation,
      range: this.createRange(startPos, endPos)
    };
  }

  private parseCompoundFact(startPos: Position): Fact {
    const children: Fact[] = [];
    let operator: 'and' | 'or' | undefined;

    children.push(this.parseFact());

    while (this.check(TokenType.AND) || this.check(TokenType.OR)) {
      if (this.match(TokenType.AND)) {
        operator = 'and';
      } else if (this.match(TokenType.OR)) {
        operator = 'or';
      }
      children.push(this.parseFact());
    }

    this.expect(TokenType.RPAREN, '閉じ括弧 ) が必要です');

    let evaluation: Evaluation | undefined;
    if (this.match(TokenType.AT)) {
      evaluation = this.parseEvaluation();
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Fact',
      content: '',
      operator,
      children,
      evaluation,
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 評価解析 =====

  private parseEvaluation(): Evaluation {
    const startPos = this.peek().range.start;
    let content = '';

    while (!this.isAtEnd() &&
           !this.check(TokenType.COLON) &&
           !this.check(TokenType.AND) &&
           !this.check(TokenType.OR) &&
           !this.check(TokenType.RPAREN) &&
           !this.check(TokenType.ARROW_RIGHT) &&
           !this.check(TokenType.AT) &&
           !this.check(TokenType.SEMICOLON) &&
           !this.check(TokenType.NEWLINE)) {
      content += this.advance().value + ' ';
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Evaluation',
      content: content.trim(),
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 要件解析（行内複合構文対応） =====

  private parseRequirement(): Requirement {
    const startPos = this.peek().range.start;
    let concluded: 'positive' | 'negative' | undefined;

    // 結論マーカーをチェック
    if (this.match(TokenType.PLUS)) {
      concluded = 'positive';
    } else if (this.match(TokenType.EXCLAIM)) {
      concluded = 'negative';
    }

    const openBracket = this.expect(TokenType.LPAREN, '要件には(が必要です');
    const openBracketPos = openBracket.range.start;

    // 要件名を取得
    let name = '';
    let lastTokenEnd = openBracket.range.end;
    while (!this.isAtEnd() &&
           !this.check(TokenType.RPAREN) &&
           !this.check(TokenType.NEWLINE)) {
      const token = this.advance();
      name += token.value;
      lastTokenEnd = token.range.end;
    }

    // 閉じ括弧がない場合のエラー（開き括弧の位置でエラーを報告）
    if (this.check(TokenType.NEWLINE) || this.isAtEnd()) {
      this.addError('閉じ括弧)が見つかりません', {
        start: openBracketPos,
        end: lastTokenEnd
      });
    } else {
      this.advance(); // 」を消費
    }

    let norm: Norm | undefined;
    let fact: Fact | undefined;
    const subRequirements: Requirement[] = [];
    const reasonStatements: ReasonStatement[] = [];

    // 行内複合構文: (要件): %規範 <= 事実 または (要件): $定数 <= 事実
    if (this.match(TokenType.COLON)) {
      // 規範がある場合（%規範 または $定数参照）
      if (this.check(TokenType.PERCENT) ||
          this.check(TokenType.DOLLAR) ||
          this.check(TokenType.PLUS) ||
          this.check(TokenType.EXCLAIM)) {
        norm = this.parseNorm();
        // 規範の後のあてはめは規範に含まれる
        fact = norm.fact;
      } else if (this.match(TokenType.ARROW_LEFT)) {
        // : <= の場合（規範なしであてはめ）
        fact = this.parseFact();
      }
    } else if (this.match(TokenType.ARROW_LEFT)) {
      // 規範なしで直接あてはめ
      fact = this.parseFact();
    }

    this.skipNewlines();

    // 下位要件がある場合（インデント）
    if (this.check(TokenType.INDENT)) {
      this.advance();

      while (!this.isAtEnd() && !this.check(TokenType.DEDENT)) {
        if (this.check(TokenType.PERCENT) ||
            this.check(TokenType.DOLLAR) ||
            (this.check(TokenType.PLUS) && (this.peek(1).type === TokenType.PERCENT || this.peek(1).type === TokenType.DOLLAR)) ||
            (this.check(TokenType.EXCLAIM) && (this.peek(1).type === TokenType.PERCENT || this.peek(1).type === TokenType.DOLLAR))) {
          subRequirements.push(this.parseNormAsRequirement());
        } else if (this.check(TokenType.LPAREN) ||
                   (this.check(TokenType.PLUS) && this.peek(1).type === TokenType.LPAREN) ||
                   (this.check(TokenType.EXCLAIM) && this.peek(1).type === TokenType.LPAREN)) {
          subRequirements.push(this.parseRequirement());
        } else if (this.check(TokenType.ARROW_LEFT)) {
          // 下位のあてはめ
          this.advance();
          fact = this.parseFact();
        } else if (this.check(TokenType.SEMICOLON)) {
          reasonStatements.push(this.parseReasonStatement());
        } else if (this.check(TokenType.NEWLINE)) {
          this.advance();
        } else if (this.check(TokenType.COMMENT)) {
          this.advance();
        } else {
          break;
        }
      }

      if (this.check(TokenType.DEDENT)) {
        this.advance();
      }
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Requirement',
      concluded,
      name,
      norm,
      fact,
      subRequirements: subRequirements.length > 0 ? subRequirements : undefined,
      reasonStatements: reasonStatements.length > 0 ? reasonStatements : undefined,
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 規範を要件として解析（規範ネスト対応） =====

  private parseNormAsRequirement(): Requirement {
    const startPos = this.peek().range.start;
    const norm = this.parseNorm();

    this.skipNewlines();

    const subRequirements: Requirement[] = [];
    const reasonStatements: ReasonStatement[] = [];

    // 下位要件（インデント）- 規範ネスト対応
    if (this.check(TokenType.INDENT)) {
      this.advance();

      while (!this.isAtEnd() && !this.check(TokenType.DEDENT)) {
        if (this.check(TokenType.PERCENT) ||
            this.check(TokenType.DOLLAR) ||
            (this.check(TokenType.PLUS) && (this.peek(1).type === TokenType.PERCENT || this.peek(1).type === TokenType.DOLLAR)) ||
            (this.check(TokenType.EXCLAIM) && (this.peek(1).type === TokenType.PERCENT || this.peek(1).type === TokenType.DOLLAR))) {
          subRequirements.push(this.parseNormAsRequirement());
        } else if (this.check(TokenType.LPAREN) ||
                   (this.check(TokenType.PLUS) && this.peek(1).type === TokenType.LPAREN) ||
                   (this.check(TokenType.EXCLAIM) && this.peek(1).type === TokenType.LPAREN)) {
          subRequirements.push(this.parseRequirement());
        } else if (this.check(TokenType.ARROW_LEFT)) {
          // あてはめを規範に追加
          this.advance();
          norm.fact = this.parseFact();
        } else if (this.check(TokenType.SEMICOLON)) {
          reasonStatements.push(this.parseReasonStatement());
        } else if (this.check(TokenType.NEWLINE)) {
          this.advance();
        } else if (this.check(TokenType.COMMENT)) {
          this.advance();
        } else {
          break;
        }
      }

      if (this.check(TokenType.DEDENT)) {
        this.advance();
      }
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Requirement',
      concluded: norm.concluded,
      name: norm.content,
      norm,
      fact: norm.fact,
      subRequirements: subRequirements.length > 0 ? subRequirements : undefined,
      reasonStatements: reasonStatements.length > 0 ? reasonStatements : undefined,
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 規範解析（規範ネスト対応） =====

  private parseNorm(): Norm {
    const startPos = this.peek().range.start;
    let concluded: 'positive' | 'negative' | undefined;

    // 結論マーカーをチェック
    if (this.match(TokenType.PLUS)) {
      concluded = 'positive';
    } else if (this.match(TokenType.EXCLAIM)) {
      concluded = 'negative';
    }

    // $定数参照の場合
    if (this.match(TokenType.DOLLAR)) {
      return this.parseConstantReference(startPos, concluded);
    }

    this.expect(TokenType.PERCENT, '規範には % が必要です');

    // 規範内容を取得
    let content = '';
    while (!this.isAtEnd() &&
           !this.check(TokenType.CARET) &&
           !this.check(TokenType.ARROW_LEFT) &&
           !this.check(TokenType.COLON) &&
           !this.check(TokenType.AS) &&
           !this.check(TokenType.SEMICOLON) &&
           !this.check(TokenType.NEWLINE)) {
      content += this.advance().value + ' ';
    }
    content = content.trim();

    let reference: Reference | undefined;
    let fact: Fact | undefined;
    let subNorm: Norm | undefined;
    let constantDefinition: string | undefined;

    // 根拠条文
    if (this.match(TokenType.CARET)) {
      reference = this.parseReference();
    }

    // 下位規範（: %）または 行内あてはめ
    if (this.match(TokenType.COLON)) {
      if (this.check(TokenType.PERCENT) ||
          this.check(TokenType.PLUS) ||
          this.check(TokenType.EXCLAIM)) {
        subNorm = this.parseNorm();
        // 下位規範のあてはめを引き継ぐ
        if (subNorm.fact && !fact) {
          fact = subNorm.fact;
        }
      }
    }

    // あてはめ
    if (this.match(TokenType.ARROW_LEFT)) {
      fact = this.parseFact();
    }

    // 定数定義（as 定数名）
    if (this.match(TokenType.AS)) {
      let constName = '';
      // <= が来たら定数名の終わり
      while (!this.isAtEnd() &&
             !this.check(TokenType.ARROW_LEFT) &&
             !this.check(TokenType.NEWLINE)) {
        constName += this.advance().value + ' ';
      }
      constantDefinition = constName.trim();

      // as の後にあてはめがある場合
      if (this.match(TokenType.ARROW_LEFT)) {
        fact = this.parseFact();
      }

      // 定数を登録
      const norm: Norm = {
        type: 'Norm',
        concluded,
        content,
        reference,
        subNorm,
        fact,
        range: this.createRange(startPos, this.peek().range.start)
      };

      this.constants.set(constantDefinition, {
        type: 'ConstantDefinition',
        name: constantDefinition,
        value: norm,
        range: norm.range
      });
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Norm',
      concluded,
      content,
      reference,
      subNorm,
      fact,
      constantDefinition,
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 定数参照解析 =====

  private parseConstantReference(startPos: Position, concluded?: 'positive' | 'negative'): Norm {
    // 定数名を取得
    let constName = '';
    while (!this.isAtEnd() &&
           !this.check(TokenType.ARROW_LEFT) &&
           !this.check(TokenType.COLON) &&
           !this.check(TokenType.SEMICOLON) &&
           !this.check(TokenType.NEWLINE)) {
      constName += this.advance().value + ' ';
    }
    constName = constName.trim();

    // 定数を検索して展開
    const constDef = this.constants.get(constName);
    let content = constName;
    let reference: Reference | undefined;

    if (constDef) {
      // 定数が見つかった場合、その内容を使用
      content = constDef.value.content;
      reference = constDef.value.reference;
    } else {
      // 定数が見つからない場合はエラー
      this.addError(`定数 ${constName} が定義されていません`);
    }

    // あてはめ
    let fact: Fact | undefined;
    if (this.match(TokenType.ARROW_LEFT)) {
      fact = this.parseFact();
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Norm',
      concluded,
      content,
      reference,
      fact,
      constantReference: constName, // 参照元の定数名を保持
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 論点解析 =====

  private parseIssueAsRequirement(): Requirement {
    const startPos = this.peek().range.start;
    const issue = this.parseIssue();

    const endPos = this.peek().range.start;
    return {
      type: 'Requirement',
      concluded: issue.norm.concluded,
      name: issue.question,
      issue,
      range: this.createRange(startPos, endPos)
    };
  }

  private parseIssue(): Issue {
    const startPos = this.peek().range.start;
    this.expect(TokenType.QUESTION, '論点には ? が必要です');

    // 問題提起を取得
    let question = '';
    while (!this.isAtEnd() &&
           !this.check(TokenType.TILDE_ARROW) &&
           !this.check(TokenType.IMPLIES) &&
           !this.check(TokenType.NEWLINE)) {
      question += this.advance().value + ' ';
    }
    question = question.trim();

    // 理由
    const reasons: Reason[] = [];
    if (this.match(TokenType.TILDE_ARROW)) {
      reasons.push(...this.parseReasons());
    }

    // 規範
    this.expect(TokenType.IMPLIES, '論点には => が必要です');
    const norm = this.parseNorm();

    this.skipNewlines();

    // 下位要件
    if (this.check(TokenType.INDENT)) {
      this.advance();

      while (!this.isAtEnd() && !this.check(TokenType.DEDENT)) {
        if (this.check(TokenType.PERCENT) ||
            this.check(TokenType.PLUS) ||
            this.check(TokenType.EXCLAIM)) {
          if (!norm.subRequirements) {
            norm.subRequirements = [];
          }
          norm.subRequirements.push(this.parseNormAsRequirement());
        } else if (this.check(TokenType.NEWLINE)) {
          this.advance();
        } else {
          break;
        }
      }

      if (this.check(TokenType.DEDENT)) {
        this.advance();
      }
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Issue',
      question,
      reasons: reasons.length > 0 ? reasons : undefined,
      norm,
      range: this.createRange(startPos, endPos)
    };
  }

  // ===== 理由解析 =====

  private parseReasons(): Reason[] {
    const reasons: Reason[] = [];
    const startPos = this.peek().range.start;

    // 括弧付きの複合理由
    if (this.match(TokenType.LPAREN)) {
      let content = '';
      while (!this.isAtEnd() &&
             !this.check(TokenType.AND) &&
             !this.check(TokenType.OR) &&
             !this.check(TokenType.RPAREN)) {
        content += this.advance().value + ' ';
      }

      reasons.push({
        type: 'Reason',
        content: content.trim(),
        range: this.createRange(startPos, this.peek().range.start)
      });

      while (this.check(TokenType.AND) || this.check(TokenType.OR)) {
        const op = this.match(TokenType.AND) ? 'and' : 'or';
        this.advance();

        const reasonStart = this.peek().range.start;
        let reasonContent = '';
        while (!this.isAtEnd() &&
               !this.check(TokenType.AND) &&
               !this.check(TokenType.OR) &&
               !this.check(TokenType.RPAREN)) {
          reasonContent += this.advance().value + ' ';
        }

        reasons.push({
          type: 'Reason',
          content: reasonContent.trim(),
          operator: op as 'and' | 'or',
          range: this.createRange(reasonStart, this.peek().range.start)
        });
      }

      this.expect(TokenType.RPAREN, '閉じ括弧 ) が必要です');
    } else {
      // 単一理由
      let content = '';
      while (!this.isAtEnd() &&
             !this.check(TokenType.IMPLIES) &&
             !this.check(TokenType.NEWLINE)) {
        content += this.advance().value + ' ';
      }

      reasons.push({
        type: 'Reason',
        content: content.trim(),
        range: this.createRange(startPos, this.peek().range.start)
      });
    }

    return reasons;
  }

  // ===== 効果解析 =====

  private parseEffect(): Effect {
    const startPos = this.peek().range.start;
    this.expect(TokenType.ARROW_RIGHT, '効果には >> が必要です');

    let content = '';
    while (!this.isAtEnd() && !this.check(TokenType.NEWLINE)) {
      content += this.advance().value + ' ';
    }

    const endPos = this.peek().range.start;
    return {
      type: 'Effect',
      content: content.trim(),
      range: this.createRange(startPos, endPos)
    };
  }
}

/** 便利な構文解析関数 */
export function parse(source: string): ParseResult {
  const parser = new Parser(source);
  return parser.parse();
}
