# ほうじ茶 設計構想

## 概要

ほうじ茶は、matchaという非OSSプロジェクトに触発されて開発された法的推論言語です。

## 設計思想

### コードにおけるエラー = 法的推論におけるエラー

プログラミングにおいてコンパイルエラーが「これじゃ動かない」と教えてくれるように、
ほうじ茶は「この法的推論は構造的に成立しない」と教えてくれます。

- **形式的チェック**（要件の欠落など）→ プログラム（ほうじ茶）の仕事
- **実質的判断**（論理矛盾、事実認定など）→ AI/法律家の仕事

### 法学の基礎構造

```
法源（条文・法令等）
    ↓ 文言を分解
法的要件
    ↓ 不確定性がある場合
解釈（規範）
    ↓
事実 + 法的評価（あてはめ）
    ↓ 全要件を満たす場合
法的効果
    ↑
法的主張（訴訟物クラス）※主張≠要件
```

### 記号と法学概念の対応

| 記号 | 法学概念 |
|------|---------|
| `#` | 法的主張（請求原因/訴因） |
| `^` | 法源（条文参照） |
| `*` | 法的要件 |
| `%` | 解釈（規範） |
| `?` | 論点（解釈が不確定） |
| `<=` | 法的評価（あてはめ） |
| `>>` | 法的効果 |

---

## 法的権威充足構造（将来構想）

### 概念

法学では何かを確定させるときに「それが何の権威に支えられているか」を常に考える。
権威は固定的な階層ではなく、**通用力**（みんながこれを基準にしている度合い）によって動的に決まる。

### 暫定的な階層

```
【第1層：最高規範】
└── 憲法、条約

【第2層：法的拘束力あり（通用力が確立）】
├── 法律（国会制定法）
├── 政令・省令・条例（委任に基づく）
├── 最高裁判例（裁判所は逆らえない）
├── 通説（通用力が確立したもの）
└── 行政解釈（行政相手の訴訟では拘束力あり）

【第3層以下：通用力によって可変】
├── 高裁判例
├── 地裁判例
├── 有力説
├── 学説
└── etc.
```

### 現時点での設計方針

**この構造の詳細な実装は将来のAIエコシステム設計で検討する。**

理由：
- 通用力は事案ごとに調整が必要
- 誰に対して通用するかはタグで分析できる類ではない
- 思考ルールとしてAIに伝える方が適切
- 言語レベルではなくAIエコシステム全体の設計の話

現時点では：
- YAMLで`出典`を記録できる柔軟な構造を維持
- 権威の評価ロジックは固定せず、拡張可能にしておく
- MCPツールを通じてAIが権威情報を参照・判断できるようにする

---

## AIとの協働（将来構想）

### 目指す姿

```
1. AI: 事実を受け取る
2. AI: MCPツールで .houjicha を生成
3. ほうじ茶: エラー返す「必須要件Xが未検討」
4. AI: 修正して再生成
5. ほうじ茶: 警告返す「論点Yの検討を推奨」
6. AI: 必要性を判断してスキップ or 追加
7. ほうじ茶: OK
8. AI: 完成した法的推論を返す
```

### 法的三段論法の担保

AIが法的推論を行う際、法的三段論法は絶対に落とせない：

```
大前提（規範）：Xという要件を満たせばYという効果が生じる
小前提（事実）：本件ではXという事実がある
結論：よってYという効果が生じる
```

ほうじ茶はこの構造を強制することで品質を担保する。

### 弁護士による監督

- AIは弁護士の監督下で動く（非弁行為にならない）
- 最終判断は人間（弁護士）が行う
- ほうじ茶は構造的な品質チェックを提供

---

## 柔軟性の担保

### 設計原則

1. **YAMLスキーマは拡張可能に**
   - 新しい属性（権威レベル、通用力等）を後から追加可能
   - 既存のデータとの後方互換性を維持

2. **エラーレベルは設定可能に**
   - 必須/推奨の区別は設定で変更可能
   - AIエコシステムの要求に応じて調整可能

3. **MCPツールは汎用的に**
   - 特定のワークフローに縛られない設計
   - 様々なAIエージェントから利用可能

4. **法的権威の判断ロジックは外部化**
   - 言語コアには組み込まない
   - AIの思考ルールとして別途定義

---

## MCPツール設計

### 設計思想

ほうじ茶のMCPツールは、プログラミング言語におけるLSP（Language Server Protocol）と同じ役割を果たす。

```
プログラミング言語/LSP  =  ほうじ茶/MCP
─────────────────────────────────────────
コンパイルエラー        →  必須要件の欠落エラー
Linter警告              →  論点の検討推奨
補完候補                →  要件・論点の候補
スニペット展開          →  テンプレート展開
シンボル検索            →  条文検索
```

**houjichaがやること**:
- 入力補助（補完、テンプレート展開）
- エラー検出（バリデーション）
- データ提供（RAG、条文DB）

**houjichaがやらないこと**:
- 契約書の解析（AIシステムの仕事）
- 法令適合性の判断（AIシステムの仕事）
- 事実認定（法律家の仕事）

### ツール一覧

#### 検証系

```typescript
// バリデーション（エラー/警告/ヒント + Ghost補完情報）
houjicha_validate(content: string) → {
  errors: [
    { line: number, character: number, message: string, severity: "error" }
  ],
  warnings: [
    { line: number, character: number, message: string, severity: "warning" }
  ],
  hints: [
    // Ghost補完相当の情報も含む
    { line: number, character: number, message: string, suggestion: string }
  ],
  nextSuggestions: [
    // 次に何を書くべきかの提案
    { position: { line: number, character: number }, candidates: string[] }
  ]
}
```

#### 補完系

```typescript
// 補完候補を取得（Ctrl+Space相当）
houjicha_get_completions(
  content: string,
  position: { line: number, character: number }
) → {
  items: [
    {
      id: string,
      label: string,           // 表示名
      insertText: string,      // 挿入されるテキスト
      kind: "requirement" | "norm" | "issue" | "effect" | "template",
      detail?: string          // 追加説明
    }
  ]
}

// 補完を適用
houjicha_apply_completion(
  content: string,
  position: { line: number, character: number },
  completionId: string
) → {
  newContent: string  // 補完適用後の全文
}
```

#### テンプレート系

```typescript
// テンプレート一覧
houjicha_list_templates(category?: string) → {
  templates: [
    { id: string, name: string, category: string, description?: string }
  ]
}

// テンプレート詳細取得
houjicha_get_template(id: string) → {
  id: string,
  name: string,
  category: string,
  sourceText?: string,           // 条文原文
  requirements: [
    {
      name: string,
      norm?: string,
      required: boolean,
      subRequirements?: [...]
    }
  ],
  issues: [
    {
      name: string,
      reason?: string,
      norm?: string,
      required: boolean
    }
  ]
}

// テンプレート検索
houjicha_search_templates(query: string) → {
  results: [
    { id: string, name: string, relevance: number }
  ]
}

// テンプレート展開（/gen相当）
houjicha_expand_template(
  templateId: string,
  context?: {
    facts?: string[],
    subject?: string  // 「甲の行為」等
  }
) → {
  content: string  // 展開された.houjichaコード
}

// 新規テンプレート登録
houjicha_register_template(template: {
  id: string,
  name: string,
  category: string,
  sourceText?: string,
  requirements: [...],
  issues: [...]
}) → {
  success: boolean,
  message?: string
}

// 既存テンプレートに追加
houjicha_add_to_template(
  templateId: string,
  addition: {
    type: "requirement" | "issue",
    name: string,
    norm?: string,
    reason?: string,
    required: boolean
  }
) → {
  success: boolean,
  message?: string
}
```

#### スニペット系

```typescript
// スニペット一覧
houjicha_list_snippets() → {
  snippets: [
    { id: string, trigger: string, description?: string }
  ]
}

// スニペット登録
houjicha_register_snippet(snippet: {
  id: string,
  trigger: string,       // "/損害賠償" 等
  content: string,       // 展開されるテキスト
  description?: string
}) → {
  success: boolean,
  message?: string
}
```

### AIの利用フロー

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 事実を受け取る                                           │
│    「甲がAの時計を持ち去った」                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. houjicha_search_templates("時計 持ち去り")               │
│    → 窃盗罪、横領罪がヒット                                 │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. houjicha_get_template("刑法235条")                       │
│    → 要件（他人の財物、窃取）、論点（不法領得の意思）を取得 │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. houjicha_expand_template("刑法235条", { facts: [...] })  │
│    → 雛形を取得                                             │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. AIが雛形に事実をあてはめて .houjicha を編集              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. houjicha_validate(content)                               │
│    → Error: 「不法領得の意思」が未検討                      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 7. houjicha_get_completions(content, position)              │
│    → 「?不法領得の意思」が候補に                            │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 8. houjicha_apply_completion(...) で追加                    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 9. houjicha_validate(content) → OK                          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 10. 完成した法的推論を返す                                  │
└─────────────────────────────────────────────────────────────┘
```

### データの登録可能範囲

| レイヤー | 内容 | 登録 |
|---------|------|------|
| 言語仕様 | 記号（*, %, ?, >>等） | 不可（固定） |
| テンプレート | 条文の要件・論点 | 可能 |
| 論点追加 | 既存テンプレートへの追加 | 可能 |
| スニペット | カスタム定型文 | 可能 |

---

## 次のステップ

1. [x] README.md作成
2. [x] GitHubにプッシュ
3. [x] MCPツールの設計
4. [ ] MCPツールの実装
5. [ ] AIエコシステム全体の設計（法的権威充足構造の詳細含む）
