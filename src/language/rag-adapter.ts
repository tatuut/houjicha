/**
 * Chai - RAGアダプターインターフェース
 *
 * ベクトルDBとの連携を抽象化するアダプター。
 * 実際のDB実装（Pinecone, Qdrant, ChromaDB等）は
 * このインターフェースを実装することで接続可能。
 */

/** ベクトル検索結果 */
export interface VectorSearchResult {
  /** 一意なID */
  id: string;
  /** 類似度スコア (0-1) */
  score: number;
  /** メタデータ */
  metadata: Record<string, unknown>;
  /** テキスト内容（任意） */
  content?: string;
}

/** 登録するドキュメントの粒度 */
export type DocumentGranularity = 'coarse' | 'fine';

/** 登録するドキュメント */
export interface RAGDocument {
  /** 一意なID */
  id: string;
  /** 埋め込み対象のテキスト */
  text: string;
  /** 粒度（coarse: コンテキスト全体, fine: 個別要素） */
  granularity: DocumentGranularity;
  /** メタデータ */
  metadata: {
    /** ドキュメントタイプ */
    type: 'claim' | 'requirement' | 'norm' | 'issue' | 'fact' | 'effect' | 'reason';
    /** ソースファイル */
    sourceFile?: string;
    /** 行番号 */
    line?: number;
    /** 親要素のID（細粒度の場合） */
    parentId?: string;
    /** 関連条文 */
    articleRef?: string;
    /** カスタムメタデータ */
    [key: string]: unknown;
  };
}

/** 関係性の種類 */
export type RelationType =
  | 'contains'      // 親子関係（主張が要件を含む等）
  | 'references'    // 参照関係（条文参照等）
  | 'interprets'    // 解釈関係（規範が要件を解釈する）
  | 'applies'       // あてはめ関係（事実が規範に当てはまる）
  | 'similar'       // 類似関係（RAGで発見）
  | 'contrasts';    // 対比関係（異なる解釈等）

/** 関係性 */
export interface RAGRelation {
  /** ソースドキュメントID */
  sourceId: string;
  /** ターゲットドキュメントID */
  targetId: string;
  /** 関係の種類 */
  type: RelationType;
  /** 関係の強さ (0-1) */
  weight?: number;
  /** メタデータ */
  metadata?: Record<string, unknown>;
}

/**
 * RAGアダプターインターフェース
 *
 * 実装例:
 * - PineconeAdapter
 * - QdrantAdapter
 * - ChromaDBAdapter
 * - InMemoryAdapter（テスト用）
 */
export interface RAGAdapter {
  /** アダプター名 */
  readonly name: string;

  /**
   * 接続を初期化
   */
  connect(): Promise<void>;

  /**
   * 接続を切断
   */
  disconnect(): Promise<void>;

  /**
   * ドキュメントを登録（埋め込みベクトル化して保存）
   * @param documents 登録するドキュメントの配列
   */
  upsertDocuments(documents: RAGDocument[]): Promise<void>;

  /**
   * ドキュメントを削除
   * @param ids 削除するドキュメントIDの配列
   */
  deleteDocuments(ids: string[]): Promise<void>;

  /**
   * テキストで類似検索
   * @param query 検索クエリ
   * @param options 検索オプション
   */
  search(query: string, options?: SearchOptions): Promise<VectorSearchResult[]>;

  /**
   * 関係性を登録
   * @param relations 登録する関係性の配列
   */
  upsertRelations?(relations: RAGRelation[]): Promise<void>;

  /**
   * 関係性を取得
   * @param documentId ドキュメントID
   * @param types 取得する関係性の種類（省略時は全て）
   */
  getRelations?(documentId: string, types?: RelationType[]): Promise<RAGRelation[]>;
}

/** 検索オプション */
export interface SearchOptions {
  /** 取得する最大件数 */
  topK?: number;
  /** 最小スコア閾値 */
  minScore?: number;
  /** フィルター条件 */
  filter?: {
    /** ドキュメントタイプでフィルタ */
    types?: RAGDocument['metadata']['type'][];
    /** 粒度でフィルタ */
    granularity?: DocumentGranularity;
    /** 条文参照でフィルタ */
    articleRef?: string;
    /** カスタムフィルタ */
    [key: string]: unknown;
  };
  /** 関係性を含めて拡張検索するか */
  expandRelations?: boolean;
}

/**
 * ダミー実装（テスト用・開発用）
 * 実際のベクトルDBを接続するまでのプレースホルダー
 */
export class DummyRAGAdapter implements RAGAdapter {
  readonly name = 'dummy';
  private documents: Map<string, RAGDocument> = new Map();
  private relations: RAGRelation[] = [];

  async connect(): Promise<void> {
    console.log('[DummyRAG] Connected');
  }

  async disconnect(): Promise<void> {
    console.log('[DummyRAG] Disconnected');
  }

  async upsertDocuments(documents: RAGDocument[]): Promise<void> {
    for (const doc of documents) {
      this.documents.set(doc.id, doc);
    }
    console.log(`[DummyRAG] Upserted ${documents.length} documents`);
  }

  async deleteDocuments(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.documents.delete(id);
    }
    console.log(`[DummyRAG] Deleted ${ids.length} documents`);
  }

  async search(query: string, options?: SearchOptions): Promise<VectorSearchResult[]> {
    // ダミー実装：単純なテキストマッチング
    const results: VectorSearchResult[] = [];
    const topK = options?.topK ?? 10;
    const minScore = options?.minScore ?? 0;

    for (const [id, doc] of this.documents) {
      // フィルタ適用
      if (options?.filter?.types && !options.filter.types.includes(doc.metadata.type)) {
        continue;
      }
      if (options?.filter?.granularity && doc.granularity !== options.filter.granularity) {
        continue;
      }
      if (options?.filter?.articleRef && doc.metadata.articleRef !== options.filter.articleRef) {
        continue;
      }

      // 簡易スコア計算（実際はベクトル類似度）
      const score = this.calculateDummyScore(query, doc.text);
      if (score >= minScore) {
        results.push({
          id,
          score,
          metadata: doc.metadata as Record<string, unknown>,
          content: doc.text,
        });
      }
    }

    // スコア降順でソート
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async upsertRelations(relations: RAGRelation[]): Promise<void> {
    for (const rel of relations) {
      // 既存の同じ関係を削除
      this.relations = this.relations.filter(
        r => !(r.sourceId === rel.sourceId && r.targetId === rel.targetId && r.type === rel.type)
      );
      this.relations.push(rel);
    }
    console.log(`[DummyRAG] Upserted ${relations.length} relations`);
  }

  async getRelations(documentId: string, types?: RelationType[]): Promise<RAGRelation[]> {
    return this.relations.filter(r => {
      const isRelated = r.sourceId === documentId || r.targetId === documentId;
      const typeMatch = !types || types.includes(r.type);
      return isRelated && typeMatch;
    });
  }

  /** ダミーのスコア計算（キーワードマッチング） */
  private calculateDummyScore(query: string, text: string): number {
    const queryWords = query.toLowerCase().split(/\s+/);
    const textLower = text.toLowerCase();
    let matches = 0;
    for (const word of queryWords) {
      if (textLower.includes(word)) {
        matches++;
      }
    }
    return queryWords.length > 0 ? matches / queryWords.length : 0;
  }
}

/**
 * RAGマネージャー
 * アダプターの切り替えと共通処理を管理
 */
export class RAGManager {
  private adapter: RAGAdapter;
  private isConnected = false;

  constructor(adapter?: RAGAdapter) {
    this.adapter = adapter ?? new DummyRAGAdapter();
  }

  /** アダプターを設定 */
  setAdapter(adapter: RAGAdapter): void {
    if (this.isConnected) {
      throw new Error('Cannot change adapter while connected');
    }
    this.adapter = adapter;
  }

  /** 現在のアダプター名を取得 */
  getAdapterName(): string {
    return this.adapter.name;
  }

  /** 接続 */
  async connect(): Promise<void> {
    await this.adapter.connect();
    this.isConnected = true;
  }

  /** 切断 */
  async disconnect(): Promise<void> {
    await this.adapter.disconnect();
    this.isConnected = false;
  }

  /** ドキュメント登録 */
  async upsertDocuments(documents: RAGDocument[]): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Not connected to RAG');
    }
    await this.adapter.upsertDocuments(documents);
  }

  /** ドキュメント削除 */
  async deleteDocuments(ids: string[]): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Not connected to RAG');
    }
    await this.adapter.deleteDocuments(ids);
  }

  /** 検索 */
  async search(query: string, options?: SearchOptions): Promise<VectorSearchResult[]> {
    if (!this.isConnected) {
      throw new Error('Not connected to RAG');
    }
    return this.adapter.search(query, options);
  }

  /** 関係性登録 */
  async upsertRelations(relations: RAGRelation[]): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Not connected to RAG');
    }
    if (this.adapter.upsertRelations) {
      await this.adapter.upsertRelations(relations);
    }
  }

  /** 関係性取得 */
  async getRelations(documentId: string, types?: RelationType[]): Promise<RAGRelation[]> {
    if (!this.isConnected) {
      throw new Error('Not connected to RAG');
    }
    if (this.adapter.getRelations) {
      return this.adapter.getRelations(documentId, types);
    }
    return [];
  }

  /**
   * コンテキスト拡張検索
   * 粗粒度で検索後、関連する細粒度要素も取得
   */
  async searchWithContext(query: string, options?: SearchOptions): Promise<{
    coarse: VectorSearchResult[];
    fine: VectorSearchResult[];
  }> {
    // 粗粒度で検索
    const coarseResults = await this.search(query, {
      ...options,
      filter: { ...options?.filter, granularity: 'coarse' },
    });

    // 粗粒度結果の関連する細粒度要素を取得
    const fineResults: VectorSearchResult[] = [];
    for (const coarse of coarseResults) {
      const fineForCoarse = await this.search(query, {
        ...options,
        filter: {
          ...options?.filter,
          granularity: 'fine',
        },
      });
      // 親IDでフィルタ（実際の実装ではメタデータで絞り込む）
      fineResults.push(...fineForCoarse.filter(f =>
        (f.metadata as { parentId?: string }).parentId === coarse.id
      ));
    }

    return { coarse: coarseResults, fine: fineResults };
  }
}

// デフォルトのRAGマネージャーインスタンス
export const ragManager = new RAGManager();
