/**
 * Chai - レンダラー
 * AST → HTML/Markdown 変換
 * 将来WYSIWYGエディタでも使用可能な設計
 */

import {
  Document, Namespace, Claim, Requirement, Norm, Fact, Effect, Issue
} from './ast';

/** レンダリング形式 */
export type RenderFormat = 'essay' | 'structured';

/** レンダリングオプション */
export interface RenderOptions {
  format: RenderFormat;
  showStatus?: boolean;      // 充足状況を表示
  showNorms?: boolean;       // 規範を表示
  showReferences?: boolean;  // 条文参照を表示
}

const defaultOptions: RenderOptions = {
  format: 'structured',
  showStatus: true,
  showNorms: true,
  showReferences: true,
};

/**
 * AST → HTML 変換
 */
export function renderToHtml(doc: Document, options: Partial<RenderOptions> = {}): string {
  const opts = { ...defaultOptions, ...options };

  if (opts.format === 'essay') {
    return renderEssayFormat(doc, opts);
  } else {
    return renderStructuredFormat(doc, opts);
  }
}

/**
 * 答案形式（論文調）でレンダリング
 */
function renderEssayFormat(doc: Document, opts: RenderOptions): string {
  let html = '<div class="chai-essay">\n';
  let sectionNum = 0;

  for (const child of doc.children) {
    if (child.type === 'Namespace') {
      sectionNum++;
      html += renderNamespaceEssay(child, sectionNum, opts);
    } else if (child.type === 'Claim') {
      sectionNum++;
      html += renderClaimEssay(child, sectionNum, 0, opts);
    }
  }

  html += '</div>';
  return html;
}

function renderNamespaceEssay(ns: Namespace, sectionNum: number, opts: RenderOptions): string {
  let html = `<section class="namespace">\n`;
  html += `<h2>第${toKanjiNum(sectionNum)} ${ns.name}</h2>\n`;

  let claimNum = 0;
  for (const child of ns.children) {
    if (child.type === 'Claim') {
      claimNum++;
      html += renderClaimEssay(child, claimNum, 1, opts);
    }
  }

  html += '</section>\n';
  return html;
}

function renderClaimEssay(claim: Claim, num: number, depth: number, opts: RenderOptions): string {
  let html = `<section class="claim depth-${depth}">\n`;

  // 見出し
  const prefix = depth === 0 ? `第${toKanjiNum(num)}` : `${num}`;
  const refText = claim.reference && opts.showReferences
    ? `（${claim.reference.citation}）`
    : '';
  html += `<h${depth + 2}>${prefix} ${claim.name}${refText}の検討</h${depth + 2}>\n`;

  // 要件の検討
  if (claim.requirements && claim.requirements.length > 0) {
    html += `<div class="requirements">\n`;
    html += `<h${depth + 3}>(1) 構成要件該当性</h${depth + 3}>\n`;

    let reqLabel = 'ア';
    for (const req of claim.requirements) {
      html += renderRequirementEssay(req, reqLabel, depth + 1, opts);
      reqLabel = nextLabel(reqLabel);
    }
    html += '</div>\n';
  }

  // 結論
  if (claim.effect) {
    html += `<div class="conclusion">\n`;
    html += `<h${depth + 3}>(2) 結論</h${depth + 3}>\n`;
    html += `<p>以上より、${claim.effect.content}。</p>\n`;
    html += '</div>\n';
  }

  html += '</section>\n';
  return html;
}

function renderRequirementEssay(req: Requirement, label: string, depth: number, opts: RenderOptions): string {
  let html = `<div class="requirement">\n`;
  html += `<p><strong>${label} 「${req.name}」について</strong></p>\n`;

  // 規範
  if (req.norm && opts.showNorms) {
    html += `<p class="norm">${req.norm.content}。</p>\n`;
  }

  // あてはめ
  if (req.fact) {
    html += `<p class="fact">本件では、${req.fact.content}。</p>\n`;
  }

  // 論点
  if (req.issue) {
    html += `<div class="issue">\n`;
    html += `<p class="issue-question">この点、${req.issue.question}が問題となる。</p>\n`;
    if (req.issue.reasons && req.issue.reasons.length > 0) {
      html += `<p class="issue-reason">${req.issue.reasons.map(r => r.content).join('、')}から、</p>\n`;
    }
    if (req.issue.norm) {
      html += `<p class="issue-norm">${req.issue.norm.content}と解する。</p>\n`;
    }
    html += '</div>\n';
  }

  // 結論
  if (opts.showStatus) {
    const status = req.concluded === 'positive' ? '充足する' :
                   req.concluded === 'negative' ? '充足しない' :
                   req.fact ? '充足すると考えられる' : '';
    if (status) {
      html += `<p class="req-conclusion">よって、「${req.name}」を${status}。</p>\n`;
    }
  }

  // 下位要件
  if (req.subRequirements && req.subRequirements.length > 0) {
    let subLabel = '(ア)';
    for (const sub of req.subRequirements) {
      html += renderRequirementEssay(sub, subLabel, depth + 1, opts);
      subLabel = nextSubLabel(subLabel);
    }
  }

  html += '</div>\n';
  return html;
}

/**
 * 構造化リスト形式でレンダリング
 */
function renderStructuredFormat(doc: Document, opts: RenderOptions): string {
  let html = '<div class="chai-structured">\n';

  for (const child of doc.children) {
    if (child.type === 'Namespace') {
      html += renderNamespaceStructured(child, opts);
    } else if (child.type === 'Claim') {
      html += renderClaimStructured(child, opts);
    }
  }

  html += '</div>';
  return html;
}

function renderNamespaceStructured(ns: Namespace, opts: RenderOptions): string {
  let html = `<section class="namespace">\n`;
  html += `<h2>📁 ${ns.name}</h2>\n`;

  for (const child of ns.children) {
    if (child.type === 'Claim') {
      html += renderClaimStructured(child, opts);
    }
  }

  html += '</section>\n';
  return html;
}

function renderClaimStructured(claim: Claim, opts: RenderOptions): string {
  let html = `<section class="claim">\n`;

  // 見出し
  const refText = claim.reference && opts.showReferences
    ? `（${claim.reference.citation}）`
    : '';

  // 充足状況サマリー
  let fulfilled = 0, total = 0;
  for (const req of claim.requirements || []) {
    total++;
    if (req.concluded === 'positive' || req.fact) fulfilled++;
  }
  const summary = total > 0 ? `[${fulfilled}/${total}]` : '';

  html += `<h3>📄 ${claim.name}${refText} ${summary}</h3>\n`;

  // 要件リスト
  if (claim.requirements && claim.requirements.length > 0) {
    html += '<ul class="requirements">\n';
    for (const req of claim.requirements) {
      html += renderRequirementStructured(req, opts);
    }
    html += '</ul>\n';
  }

  // 結論
  if (claim.effect) {
    const conclusionStatus = claim.concluded === 'positive' ? '✅' :
                             claim.concluded === 'negative' ? '❌' :
                             fulfilled === total && total > 0 ? '✅' : '❓';
    html += `<p class="conclusion"><strong>${conclusionStatus} 結論:</strong> ${claim.effect.content}</p>\n`;
  }

  html += '</section>\n';
  return html;
}

function renderRequirementStructured(req: Requirement, opts: RenderOptions): string {
  // ステータスアイコン
  const status = req.concluded === 'positive' ? '✅' :
                 req.concluded === 'negative' ? '❌' :
                 req.issue ? '⚠️' :
                 req.fact ? '○' : '・';

  let html = `<li class="requirement ${req.concluded || 'pending'}">\n`;
  html += `<span class="status">${status}</span> `;
  html += `<strong>${req.name}</strong>`;

  // 規範（簡略表示）
  if (req.norm && opts.showNorms) {
    const normText = req.norm.content.length > 40
      ? req.norm.content.substring(0, 40) + '...'
      : req.norm.content;
    html += `<span class="norm">: ${normText}</span>`;
  }

  html += '\n';

  // あてはめ
  if (req.fact) {
    html += `<p class="fact">→ ${req.fact.content}</p>\n`;
  }

  // 論点
  if (req.issue) {
    html += `<p class="issue">⚠️ 論点: ${req.issue.question}</p>\n`;
  }

  // 下位要件
  if (req.subRequirements && req.subRequirements.length > 0) {
    html += '<ul class="sub-requirements">\n';
    for (const sub of req.subRequirements) {
      html += renderRequirementStructured(sub, opts);
    }
    html += '</ul>\n';
  }

  html += '</li>\n';
  return html;
}

// ヘルパー関数
function toKanjiNum(n: number): string {
  const kanji = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (n <= 10) return kanji[n];
  if (n < 20) return '十' + (n % 10 === 0 ? '' : kanji[n % 10]);
  return n.toString();
}

function nextLabel(label: string): string {
  const labels = ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ'];
  const idx = labels.indexOf(label);
  return idx >= 0 && idx < labels.length - 1 ? labels[idx + 1] : label;
}

function nextSubLabel(label: string): string {
  const match = label.match(/\((.)\)/);
  if (!match) return label;
  const inner = match[1];
  const next = nextLabel(inner);
  return `(${next})`;
}

/**
 * プレビュー用HTMLテンプレート
 */
export function getPreviewHtml(content: string, format: RenderFormat): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chai プレビュー</title>
  <style>
    :root {
      --bg-color: #ffffff;
      --text-color: #333333;
      --border-color: #e0e0e0;
      --accent-color: #4a90d9;
      --success-color: #28a745;
      --warning-color: #ffc107;
      --danger-color: #dc3545;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-color: #1e1e1e;
        --text-color: #d4d4d4;
        --border-color: #404040;
        --accent-color: #569cd6;
      }
    }

    body {
      font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif;
      background: var(--bg-color);
      color: var(--text-color);
      line-height: 1.8;
      padding: 20px;
      max-width: 800px;
      margin: 0 auto;
    }

    h2 {
      border-bottom: 2px solid var(--accent-color);
      padding-bottom: 8px;
      margin-top: 24px;
    }

    h3 {
      color: var(--accent-color);
      margin-top: 20px;
    }

    .namespace {
      margin-bottom: 32px;
    }

    .claim {
      background: var(--bg-color);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      margin: 16px 0;
    }

    .requirements {
      list-style: none;
      padding-left: 0;
    }

    .requirement {
      padding: 8px 0;
      border-bottom: 1px solid var(--border-color);
    }

    .requirement:last-child {
      border-bottom: none;
    }

    .status {
      display: inline-block;
      width: 24px;
    }

    .norm {
      color: #888;
      font-size: 0.9em;
    }

    .fact {
      margin: 4px 0 4px 28px;
      color: #666;
    }

    .issue {
      margin: 4px 0 4px 28px;
      color: var(--warning-color);
    }

    .conclusion {
      margin-top: 16px;
      padding: 12px;
      background: rgba(74, 144, 217, 0.1);
      border-radius: 4px;
    }

    /* 答案形式用 */
    .chai-essay {
      text-align: justify;
    }

    .chai-essay h2 {
      text-align: center;
      border-bottom: none;
    }

    .chai-essay .norm {
      text-indent: 1em;
    }

    .chai-essay .fact {
      text-indent: 1em;
    }

    .chai-essay .req-conclusion {
      text-indent: 1em;
    }

    .toolbar {
      position: fixed;
      top: 10px;
      right: 10px;
      background: var(--bg-color);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 8px;
      z-index: 100;
    }

    .toolbar button {
      background: var(--accent-color);
      color: white;
      border: none;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      margin: 0 4px;
    }

    .toolbar button:hover {
      opacity: 0.8;
    }

    .toolbar button.active {
      background: var(--success-color);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="btn-structured" class="${format === 'structured' ? 'active' : ''}" onclick="switchFormat('structured')">構造化</button>
    <button id="btn-essay" class="${format === 'essay' ? 'active' : ''}" onclick="switchFormat('essay')">答案形式</button>
  </div>
  <div id="content">
    ${content}
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    function switchFormat(format) {
      vscode.postMessage({ command: 'switchFormat', format: format });
    }
  </script>
</body>
</html>`;
}
