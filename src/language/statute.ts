/**
 * 本件 Matcha - 条文データベース
 * 条文の構造と要件を管理する
 */

/** 条文の要件 */
export interface StatuteRequirement {
  /** 要件名（「」内に入る文言） */
  name: string;
  /** 条文上の文言 */
  text?: string;
  /** 一般的な規範・解釈 */
  norm?: string;
  /** 下位要件（ネスト） */
  subRequirements?: StatuteRequirement[];
  /** 必須かどうか（デフォルト: true） */
  required?: boolean;
  /** 論点となりやすいか */
  isIssue?: boolean;
  /** 論点の問題提起テンプレート */
  issueQuestion?: string;
}

/** 条文の効果 */
export interface StatuteEffect {
  /** 効果の内容 */
  content: string;
  /** 条件（要件がすべて満たされた場合など） */
  condition?: 'all' | 'any';
}

/** 条文定義 */
export interface Statute {
  /** 条文番号（例: "235", "709"） */
  article: string;
  /** 項（例: "1", "2"） */
  paragraph?: string;
  /** 号 */
  item?: string;
  /** 本文・但書 */
  proviso?: 'main' | 'proviso';
  /** 法律名（例: "刑法", "民法"） */
  law: string;
  /** 条文の名称（例: "窃盗罪", "不法行為"） */
  name: string;
  /** 条文の全文 */
  fullText?: string;
  /** 要件一覧 */
  requirements: StatuteRequirement[];
  /** 効果 */
  effect: StatuteEffect;
  /** 書かれざる要件（判例・通説で追加されたもの） */
  unwrittenRequirements?: StatuteRequirement[];
  /** 関連条文 */
  relatedArticles?: string[];
}

/** 条文データベース */
export interface StatuteDatabase {
  /** バージョン */
  version: string;
  /** 法律ごとの条文 */
  laws: {
    [lawName: string]: Statute[];
  };
}

/** 条文の検索キー */
export type StatuteKey = string; // "刑法235条1項" など

/** 条文キーをパース */
export function parseStatuteKey(key: string): { law: string; article: string; paragraph?: string; item?: string } | null {
  // パターン: "刑法235条1項" or "民法709条" or "235条" or "94.2"
  const patterns = [
    /^(.+?)(\d+)条(?:(\d+)項)?(?:(\d+)号)?$/,  // 刑法235条1項
    /^(\d+)(?:\.(\d+))?$/,                       // 235.1 or 235
    /^(.+?)第?(\d+)条(?:第?(\d+)項)?(?:第?(\d+)号)?$/, // 刑法第235条第1項
  ];

  for (const pattern of patterns) {
    const match = key.match(pattern);
    if (match) {
      if (pattern === patterns[1]) {
        // 数字のみのパターン
        return {
          law: '',
          article: match[1],
          paragraph: match[2],
        };
      }
      return {
        law: match[1] || '',
        article: match[2],
        paragraph: match[3],
        item: match[4],
      };
    }
  }
  return null;
}

/** 条文データベースマネージャー */
export class StatuteManager {
  private statutes: Map<string, Statute> = new Map();

  /** 条文を登録 */
  register(statute: Statute): void {
    const key = this.createKey(statute);
    this.statutes.set(key, statute);
  }

  /** 条文を検索 */
  find(key: string): Statute | undefined {
    // 正規化してから検索
    const normalized = this.normalizeKey(key);
    return this.statutes.get(normalized);
  }

  /** 部分一致検索 */
  search(query: string): Statute[] {
    const results: Statute[] = [];
    for (const [key, statute] of this.statutes) {
      if (key.includes(query) || statute.name.includes(query)) {
        results.push(statute);
      }
    }
    return results;
  }

  /** 全条文を取得 */
  getAll(): Statute[] {
    return Array.from(this.statutes.values());
  }

  /** JSONからロード */
  loadFromJSON(data: StatuteDatabase): void {
    for (const [lawName, statutes] of Object.entries(data.laws)) {
      for (const statute of statutes) {
        statute.law = lawName;
        this.register(statute);
      }
    }
  }

  private createKey(statute: Statute): string {
    let key = `${statute.law}${statute.article}条`;
    if (statute.paragraph) key += `${statute.paragraph}項`;
    if (statute.item) key += `${statute.item}号`;
    if (statute.proviso === 'proviso') key += '但書';
    return key;
  }

  private normalizeKey(key: string): string {
    // 「第」を除去、全角数字を半角に変換
    return key
      .replace(/第/g, '')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  }
}

/** デフォルトの条文データベース（刑法の一部） */
export const defaultStatutes: StatuteDatabase = {
  version: '1.0.0',
  laws: {
    '刑法': [
      {
        law: '刑法',
        article: '199',
        name: '殺人罪',
        fullText: '人を殺した者は、死刑又は無期若しくは五年以上の懲役に処する。',
        requirements: [
          { name: '人', norm: '胎児を除く生命ある人間' },
          { name: '殺した', norm: '人の死亡結果を惹起すること', subRequirements: [
            { name: '実行行為', norm: '人の死亡の現実的危険性を有する行為' },
            { name: '因果関係', norm: '行為と結果との間の条件関係及び相当因果関係', isIssue: true },
            { name: '故意', norm: '殺意（人の死亡の認識・認容）' },
          ]},
        ],
        effect: { content: '死刑又は無期若しくは五年以上の懲役', condition: 'all' },
      },
      {
        law: '刑法',
        article: '204',
        name: '傷害罪',
        fullText: '人の身体を傷害した者は、十五年以下の懲役又は五十万円以下の罰金に処する。',
        requirements: [
          { name: '人の身体', norm: '他人の身体' },
          { name: '傷害', norm: '人の生理的機能を害すること', isIssue: true, issueQuestion: '傷害の意義' },
        ],
        effect: { content: '十五年以下の懲役又は五十万円以下の罰金', condition: 'all' },
      },
      {
        law: '刑法',
        article: '235',
        name: '窃盗罪',
        fullText: '他人の財物を窃取した者は、窃盗の罪とし、十年以下の懲役又は五十万円以下の罰金に処する。',
        requirements: [
          { name: '他人の財物', norm: '他人が所有する財産的価値のある有体物' },
          { name: '窃取', norm: '占有者の意思に反して占有を自己又は第三者に移転すること', subRequirements: [
            { name: '占有', norm: '人が物を実力的に支配する関係', isIssue: true },
            { name: '占有者の意思に反して' },
            { name: '自己又は第三者に移転' },
          ]},
        ],
        unwrittenRequirements: [
          {
            name: '不法領得の意思',
            norm: '権利者を排除して他人の物を自己の所有物とし、その経済的用法に従って利用処分する意思',
            isIssue: true,
            issueQuestion: '財産犯と不可罰的な使用窃盗及び遺棄・隠匿罪との区別する必要がある',
            subRequirements: [
              { name: '権利者排除意思', norm: '権利者を排除して他人の物を自己の所有物とする意思' },
              { name: '利用処分意思', norm: '経済的用法に従って利用処分する意思' },
            ]
          },
        ],
        effect: { content: '十年以下の懲役又は五十万円以下の罰金', condition: 'all' },
        relatedArticles: ['刑法236条', '刑法38条1項'],
      },
      {
        law: '刑法',
        article: '236',
        paragraph: '1',
        name: '強盗罪',
        fullText: '暴行又は脅迫を用いて他人の財物を強取した者は、強盗の罪とし、五年以上の有期懲役に処する。',
        requirements: [
          { name: '暴行又は脅迫', norm: '相手方の反抗を抑圧するに足りる程度の暴行・脅迫' },
          { name: '他人の財物' },
          { name: '強取', norm: '暴行・脅迫を手段として財物の占有を移転すること' },
        ],
        unwrittenRequirements: [
          { name: '不法領得の意思' },
        ],
        effect: { content: '五年以上の有期懲役', condition: 'all' },
      },
      {
        law: '刑法',
        article: '246',
        paragraph: '1',
        name: '詐欺罪',
        fullText: '人を欺いて財物を交付させた者は、十年以下の懲役に処する。',
        requirements: [
          { name: '欺く行為', norm: '人を錯誤に陥らせる行為' },
          { name: '錯誤', norm: '欺く行為により生じた認識と真実との不一致' },
          { name: '処分行為', norm: '錯誤に基づく財産的処分行為' },
          { name: '財物の交付', norm: '財物の占有移転' },
          { name: '因果関係', norm: '欺く行為→錯誤→処分行為→交付の因果の流れ' },
        ],
        unwrittenRequirements: [
          { name: '不法領得の意思' },
        ],
        effect: { content: '十年以下の懲役', condition: 'all' },
      },
      {
        law: '刑法',
        article: '38',
        paragraph: '1',
        proviso: 'main',
        name: '故意',
        fullText: '罪を犯す意思がない行為は、罰しない。ただし、法律に特別の規定がある場合は、この限りでない。',
        requirements: [
          { name: '故意', norm: '犯罪事実の認識・認容' },
        ],
        effect: { content: '故意がなければ処罰されない', condition: 'all' },
      },
    ],
    '民法': [
      {
        law: '民法',
        article: '94',
        paragraph: '1',
        name: '虚偽表示',
        fullText: '相手方と通じてした虚偽の意思表示は、無効とする。',
        requirements: [
          { name: '相手方と通じて', norm: '当事者双方が虚偽であることを知っていること' },
          { name: '虚偽の意思表示', norm: '表示と真意が異なり、かつ当事者がそれを知っている意思表示' },
        ],
        effect: { content: '無効', condition: 'all' },
      },
      {
        law: '民法',
        article: '94',
        paragraph: '2',
        name: '虚偽表示の第三者保護',
        fullText: '前項の規定による意思表示の無効は、善意の第三者に対抗することができない。',
        requirements: [
          { name: '第三者', norm: '当事者及び包括承継人以外の者で、行為の外形を信頼して新たに独立の法的利害関係を有するに至った者', isIssue: true, issueQuestion: '意義' },
          { name: '善意', norm: '虚偽表示であることを知らないこと' },
        ],
        effect: { content: '無効を対抗できない', condition: 'all' },
      },
      {
        law: '民法',
        article: '709',
        name: '不法行為',
        fullText: '故意又は過失によって他人の権利又は法律上保護される利益を侵害した者は、これによって生じた損害を賠償する責任を負う。',
        requirements: [
          { name: '故意又は過失', norm: '権利侵害についての認識または注意義務違反' },
          { name: '権利又は法律上保護される利益', norm: '権利侵害または違法性' },
          { name: '侵害', norm: '権利・利益に対する侵害行為' },
          { name: '損害', norm: '財産的・精神的な不利益' },
          { name: '因果関係', norm: '行為と損害との間の相当因果関係' },
        ],
        effect: { content: '損害賠償責任', condition: 'all' },
      },
      {
        law: '民法',
        article: '415',
        paragraph: '1',
        name: '債務不履行',
        fullText: '債務者がその債務の本旨に従った履行をしないとき又は債務の履行が不能であるときは、債権者は、これによって生じた損害の賠償を請求することができる。',
        requirements: [
          { name: '債務の存在' },
          { name: '債務不履行', norm: '債務の本旨に従った履行をしないこと', subRequirements: [
            { name: '履行遅滞', norm: '履行期に履行しないこと' },
            { name: '履行不能', norm: '債務の履行が不可能になること' },
            { name: '不完全履行', norm: '履行はあるが不完全であること' },
          ]},
          { name: '帰責事由', norm: '債務者の責めに帰すべき事由', isIssue: true },
          { name: '損害' },
          { name: '因果関係' },
        ],
        effect: { content: '損害賠償請求権', condition: 'all' },
      },
    ],
  },
};

/** グローバルな条文マネージャー */
export const statuteManager = new StatuteManager();
statuteManager.loadFromJSON(defaultStatutes);
