/**
 * 本件 Matcha - Lexer テスト
 */

import { tokenize, TokenType } from '../src/language/lexer';

describe('Lexer', () => {
  describe('基本記号のトークン化', () => {
    it('主張記号 # を認識する', () => {
      const { tokens } = tokenize('#窃盗罪');
      expect(tokens.find(t => t.type === TokenType.HASH)).toBeDefined();
    });

    it('全角 ＃ も認識する', () => {
      const { tokens } = tokenize('＃窃盗罪');
      expect(tokens.find(t => t.type === TokenType.HASH)).toBeDefined();
    });

    it('根拠条文参照 ^ を認識する', () => {
      const { tokens } = tokenize('^刑法235条');
      expect(tokens.find(t => t.type === TokenType.CARET)).toBeDefined();
    });

    it('あてはめ記号 <= を認識する', () => {
      const { tokens } = tokenize('<= 事実');
      expect(tokens.find(t => t.type === TokenType.ARROW_LEFT)).toBeDefined();
    });

    it('効果記号 >> を認識する', () => {
      const { tokens } = tokenize('>> 効果');
      expect(tokens.find(t => t.type === TokenType.ARROW_RIGHT)).toBeDefined();
    });

    it('規範記号 % を認識する', () => {
      const { tokens } = tokenize('%規範');
      expect(tokens.find(t => t.type === TokenType.PERCENT)).toBeDefined();
    });

    it('論点記号 ? を認識する', () => {
      const { tokens } = tokenize('? 問題提起');
      expect(tokens.find(t => t.type === TokenType.QUESTION)).toBeDefined();
    });

    it('評価記号 @ を認識する', () => {
      const { tokens } = tokenize('@評価');
      expect(tokens.find(t => t.type === TokenType.AT)).toBeDefined();
    });
  });

  describe('日本語括弧', () => {
    it('「」を認識する', () => {
      const { tokens } = tokenize('「要件」');
      expect(tokens.find(t => t.type === TokenType.LBRACKET_JP)).toBeDefined();
      expect(tokens.find(t => t.type === TokenType.RBRACKET_JP)).toBeDefined();
    });
  });

  describe('論理演算子', () => {
    it('AND演算子 & を認識する', () => {
      const { tokens } = tokenize('事実1 & 事実2');
      expect(tokens.find(t => t.type === TokenType.AND)).toBeDefined();
    });

    it('OR演算子 | を認識する', () => {
      const { tokens } = tokenize('要件1 | 要件2');
      expect(tokens.find(t => t.type === TokenType.OR)).toBeDefined();
    });

    it('エスケープされた \\& を認識する', () => {
      const { tokens } = tokenize('\\&');
      expect(tokens.find(t => t.type === TokenType.AND)).toBeDefined();
    });
  });

  describe('結論マーカー', () => {
    it('該当 + を認識する', () => {
      const { tokens } = tokenize('+#窃盗罪');
      expect(tokens.find(t => t.type === TokenType.PLUS)).toBeDefined();
    });

    it('否定 ! を認識する', () => {
      const { tokens } = tokenize('!#窃盗罪');
      expect(tokens.find(t => t.type === TokenType.EXCLAIM)).toBeDefined();
    });
  });

  describe('論述空間', () => {
    it(':: を認識する', () => {
      const { tokens } = tokenize('::甲の罪責');
      expect(tokens.find(t => t.type === TokenType.DOUBLE_COLON)).toBeDefined();
    });
  });

  describe('定数', () => {
    it('as キーワードを認識する', () => {
      const { tokens } = tokenize('as 第三者の規範');
      expect(tokens.find(t => t.type === TokenType.AS)).toBeDefined();
    });

    it('定数参照 $ を認識する', () => {
      const { tokens } = tokenize('$第三者の規範');
      expect(tokens.find(t => t.type === TokenType.DOLLAR)).toBeDefined();
    });
  });

  describe('コメント', () => {
    it('// コメントを認識する', () => {
      const { tokens } = tokenize('// これはコメント');
      expect(tokens.find(t => t.type === TokenType.COMMENT)).toBeDefined();
    });
  });

  describe('インデント', () => {
    it('インデントを認識する', () => {
      const { tokens } = tokenize('#主張:\n    %要件');
      expect(tokens.find(t => t.type === TokenType.INDENT)).toBeDefined();
    });

    it('デデントを認識する', () => {
      const { tokens } = tokenize('#主張:\n    %要件\n#次の主張');
      expect(tokens.find(t => t.type === TokenType.DEDENT)).toBeDefined();
    });
  });

  describe('複合トークン', () => {
    it('~> を認識する', () => {
      const { tokens } = tokenize('~> 理由');
      expect(tokens.find(t => t.type === TokenType.TILDE_ARROW)).toBeDefined();
    });

    it('=> を認識する', () => {
      const { tokens } = tokenize('=> 規範');
      expect(tokens.find(t => t.type === TokenType.IMPLIES)).toBeDefined();
    });
  });
});
