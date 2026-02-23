// ── 簡易Markdownパーサー（テスト用に分離） ──
// index.html の renderMarkdown と同等のロジックをNode.js環境で動作する形に

/**
 * Markdownテキストをパースしてトークン配列に変換する
 * UI非依存なので、Node.js環境でもテスト可能
 */
export function parseMarkdown(text) {
  if (!text) return [];

  // 前処理: テーブル行間の空行を除去
  const rawLines = text.split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const cur = rawLines[i].trim();
    if (cur === '' && i + 1 < rawLines.length && rawLines[i + 1].trim().startsWith('|') && rawLines[i + 1].trim().endsWith('|')) continue;
    if (cur === '' && i > 0 && rawLines[i - 1].trim().startsWith('|') && rawLines[i - 1].trim().endsWith('|')) continue;
    lines.push(rawLines[i]);
  }

  const tokens = [];
  let listItems = [];
  let listType = null;
  let tableRows = [];
  let inTable = false;

  const flushList = () => {
    if (listItems.length > 0) {
      tokens.push({ type: listType === 'ol' ? 'ordered-list' : 'unordered-list', items: listItems });
      listItems = [];
      listType = null;
    }
  };

  const flushTable = () => {
    if (tableRows.length < 2) { tableRows = []; inTable = false; return; }
    let headerIdx = -1;
    for (let ti = 0; ti < tableRows.length; ti++) {
      if (tableRows[ti] === null) { headerIdx = ti - 1; break; }
    }
    if (headerIdx < 0) headerIdx = 0;
    const header = tableRows[headerIdx];
    const body = tableRows.filter((r, idx) => r !== null && idx !== headerIdx);
    if (!header || header.length === 0) { tableRows = []; inTable = false; return; }
    tokens.push({ type: 'table', header: header.map(c => c.trim()), body: body.map(row => row.map(c => c.trim())) });
    tableRows = [];
    inTable = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1) {
      flushList();
      const cells = trimmed.slice(1, -1).split('|');
      if (trimmed.match(/^\|[\s\-:|]+\|$/)) {
        tableRows.push(null);
      } else {
        tableRows.push(cells);
      }
      inTable = true;
      continue;
    }

    // Empty line
    if (!trimmed) {
      if (inTable) continue;
      flushList();
      continue;
    }

    if (inTable) flushTable();

    // Headings
    if (trimmed.startsWith('### ')) { flushList(); tokens.push({ type: 'h3', content: trimmed.slice(4) }); continue; }
    if (trimmed.startsWith('## ')) { flushList(); tokens.push({ type: 'h2', content: trimmed.slice(3) }); continue; }
    if (trimmed.startsWith('# ')) { flushList(); tokens.push({ type: 'h1', content: trimmed.slice(2) }); continue; }

    // HR
    if (trimmed === '---' || trimmed === '***') { flushList(); tokens.push({ type: 'hr' }); continue; }

    // Ordered list
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listItems.push(olMatch[2]);
      continue;
    }

    // Unordered list
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listItems.push(trimmed.slice(2));
      continue;
    }

    // Paragraph
    flushList();
    tokens.push({ type: 'paragraph', content: trimmed });
  }
  flushList();
  flushTable();
  return tokens;
}

/**
 * インラインMarkdown要素をパースする
 * **bold**, [link](url), `code` を検出してトークン配列にする
 */
export function parseInlineMarkdown(text) {
  if (!text || typeof text !== 'string') return [{ type: 'text', content: text || '' }];
  const tokens = [];
  const regex = /(\*\*(.+?)\*\*)|(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)/g;
  let match;
  let lastIdx = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      tokens.push({ type: 'text', content: text.slice(lastIdx, match.index) });
    }
    if (match[1]) {
      tokens.push({ type: 'bold', content: match[2] });
    } else if (match[3]) {
      tokens.push({ type: 'link', text: match[4], url: match[5] });
    } else if (match[6]) {
      tokens.push({ type: 'code', content: match[7] });
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    tokens.push({ type: 'text', content: text.slice(lastIdx) });
  }
  return tokens;
}
