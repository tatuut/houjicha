/**
 * 本件 Matcha - Parser テスト
 */

import { parse } from '../src/language/parser';

describe('Parser', () => {
  describe('主張（Claim）の解析', () => {
    it('基本的な主張を解析できる', () => {
      const { document, errors } = parse('#窃盗罪');
      expect(errors).toHaveLength(0);
      expect(document.children).toHaveLength(1);
      expect(document.children[0].type).toBe('Claim');
      if (document.children[0].type === 'Claim') {
        expect(document.children[0].name).toBe('窃盗罪');
      }
    });

    it('根拠条文付きの主張を解析できる', () => {
      const { document } = parse('#窃盗罪^刑法235条');
      if (document.children[0].type === 'Claim') {
        expect(document.children[0].reference?.citation).toBe('刑法235条');
      }
    });

    it('事実のあてはめ付きの主張を解析できる', () => {
      const { document } = parse('#窃盗罪 <= 甲の行為');
      if (document.children[0].type === 'Claim') {
        expect(document.children[0].fact?.content).toBe('甲の行為');
      }
    });

    it('結論マーカー付きの主張を解析できる', () => {
      const { document: doc1 } = parse('+#窃盗罪');
      if (doc1.children[0].type === 'Claim') {
        expect(doc1.children[0].concluded).toBe('positive');
      }

      const { document: doc2 } = parse('!#窃盗罪');
      if (doc2.children[0].type === 'Claim') {
        expect(doc2.children[0].concluded).toBe('negative');
      }
    });
  });

  describe('要件（Requirement）の解析', () => {
    it('基本的な要件を解析できる', () => {
      const { document } = parse(`#窃盗罪:
    「他人の財物」`);
      if (document.children[0].type === 'Claim') {
        expect(document.children[0].requirements).toHaveLength(1);
        expect(document.children[0].requirements[0].name).toBe('他人の財物');
      }
    });

    it('規範付きの要件を解析できる', () => {
      const { document } = parse(`#窃盗罪:
    「他人の財物」: %他人が所有する財物`);
      if (document.children[0].type === 'Claim') {
        const req = document.children[0].requirements[0];
        expect(req.norm?.content).toContain('他人が所有する');
      }
    });
  });

  describe('論述空間（Namespace）の解析', () => {
    it('論述空間を解析できる', () => {
      const { document } = parse(`::甲の罪責
    #窃盗罪`);
      expect(document.children[0].type).toBe('Namespace');
      if (document.children[0].type === 'Namespace') {
        expect(document.children[0].name).toBe('甲の罪責');
        expect(document.children[0].children).toHaveLength(1);
      }
    });
  });

  describe('論点（Issue）の解析', () => {
    it('問題提起と規範を解析できる', () => {
      const { document } = parse(`#主張:
    ? 問題提起 => %規範`);
      if (document.children[0].type === 'Claim') {
        const req = document.children[0].requirements[0];
        expect(req.issue).toBeDefined();
        expect(req.issue?.question).toContain('問題提起');
        expect(req.issue?.norm.content).toContain('規範');
      }
    });

    it('理由付きの論点を解析できる', () => {
      const { document } = parse(`#主張:
    ? 問題提起 ~> 理由 => %規範`);
      if (document.children[0].type === 'Claim') {
        const req = document.children[0].requirements[0];
        expect(req.issue?.reasons).toHaveLength(1);
      }
    });
  });

  describe('効果（Effect）の解析', () => {
    it('効果を解析できる', () => {
      const { document } = parse(`#窃盗罪:
    「要件」 <= 事実
>> 甲に窃盗罪が成立する`);
      if (document.children[0].type === 'Claim') {
        expect(document.children[0].effect?.content).toBe('甲に窃盗罪が成立する');
      }
    });
  });

  describe('複合事実の解析', () => {
    it('AND条件を解析できる', () => {
      const { document } = parse('#主張 <= (事実1 & 事実2)');
      if (document.children[0].type === 'Claim') {
        const fact = document.children[0].fact;
        expect(fact?.operator).toBe('and');
        expect(fact?.children).toHaveLength(2);
      }
    });
  });

  describe('評価の解析', () => {
    it('評価を解析できる', () => {
      const { document } = parse('#主張 <= 事実@評価');
      if (document.children[0].type === 'Claim') {
        expect(document.children[0].fact?.evaluation?.content).toBe('評価');
      }
    });
  });

  describe('定数の解析', () => {
    it('定数定義を解析できる', () => {
      const { document } = parse(`#主張:
    %規範 as 定数名`);
      expect(document.constants.has('定数名')).toBe(true);
    });
  });

  describe('コメントの解析', () => {
    it('コメントを解析できる', () => {
      const { document } = parse('// これはコメント\n#主張');
      expect(document.children.some(c => c.type === 'Comment')).toBe(true);
    });
  });
});
