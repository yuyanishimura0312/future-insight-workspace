// Cloudflare Worker: API Proxy for Future Insight Workspace
// Proxies Anthropic API, Notion API, and URL fetching
// All API keys are stored as Worker secrets (not exposed to clients)
//
// Secrets (set via `wrangler secret put`):
//   NOTION_TOKEN - Notion integration token
//   ANTHROPIC_API_KEY - Anthropic API key
//
// Vars (set in wrangler.toml):
//   ALLOWED_ORIGIN - CORS origin

// === Foresight rate limiter (stricter: 5 req/min) ===
const foresightRateLimits = new Map();
const FORESIGHT_RATE_WINDOW = 60 * 1000;
const FORESIGHT_RATE_MAX = 5;

function checkForesightRateLimit(userId) {
  const now = Date.now();
  const key = `foresight_${userId || 'anonymous'}`;
  const entry = foresightRateLimits.get(key);
  if (!entry || now - entry.windowStart > FORESIGHT_RATE_WINDOW) {
    foresightRateLimits.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= FORESIGHT_RATE_MAX) return false;
  entry.count++;
  return true;
}

// Simple in-memory rate limiter (per-worker instance)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // max requests per minute per user

function checkRateLimit(userId) {
  const now = Date.now();
  const key = userId || 'anonymous';
  const entry = rateLimits.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// Clean up old entries periodically
function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW * 2) rateLimits.delete(key);
  }
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-User-Id',
    };

    // Reject requests from non-allowed origins
    const origin = request.headers.get('Origin') || '';
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Clean up rate limits occasionally
    cleanupRateLimits();
    // Clean foresight rate limits
    const now = Date.now();
    for (const [key, entry] of foresightRateLimits) {
      if (now - entry.windowStart > FORESIGHT_RATE_WINDOW * 2) foresightRateLimits.delete(key);
    }

    try {
      // Route: /api/notion - Notion page fetcher
      if (path === '/api/notion') {
        return handleNotion(request, env, url, corsHeaders);
      }

      // Route: /api/anthropic - Anthropic API proxy
      if (path === '/api/anthropic') {
        return handleAnthropic(request, env, corsHeaders);
      }

      // Route: /api/fetch-url - URL content fetcher (replaces CORS proxies)
      if (path === '/api/fetch-url') {
        return handleFetchUrl(request, env, url, corsHeaders);
      }

      // Route: /api/foresight - Foresight question (Miratuku News)
      if (path === '/api/foresight') {
        return handleForesight(request, env, corsHeaders);
      }

      // Route: /api/foresight-builder - Build insight from bookmarks (Miratuku News)
      if (path === '/api/foresight-builder') {
        return handleForesightBuilder(request, env, corsHeaders);
      }

      return new Response(JSON.stringify({ error: 'Not found', routes: ['/api/notion', '/api/anthropic', '/api/fetch-url', '/api/foresight', '/api/foresight-builder'] }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

// === Anthropic API Proxy ===
async function handleAnthropic(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Rate limiting
  const userId = request.headers.get('X-User-Id') || 'unknown';
  if (!checkRateLimit(userId)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment.' }), {
      status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const body = await request.json();

  // Validate and sanitize the request
  const allowedModels = ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'];
  if (!allowedModels.includes(body.model)) {
    return new Response(JSON.stringify({ error: `Model not allowed: ${body.model}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Cap max_tokens to prevent abuse
  const maxTokensCap = 16000;
  if (body.max_tokens > maxTokensCap) body.max_tokens = maxTokensCap;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await resp.text();
  return new Response(data, {
    status: resp.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// === Notion API Proxy ===
async function handleNotion(request, env, url, corsHeaders) {
  const pageId = url.searchParams.get('page_id');
  if (!pageId) {
    return new Response(JSON.stringify({ error: 'page_id is required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!env.NOTION_TOKEN) {
    return new Response(JSON.stringify({ error: 'NOTION_TOKEN not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Fetch page title
  const pageResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
  });

  let title = '';
  if (pageResp.ok) {
    const pageData = await pageResp.json();
    const titleProp = pageData.properties?.title?.title;
    if (titleProp) title = titleProp.map(t => t.plain_text).join('');
  }

  // Fetch all blocks (paginated)
  let allBlocks = [];
  let cursor = undefined;
  for (let i = 0; i < 10; i++) {
    const blocksUrl = new URL(`https://api.notion.com/v1/blocks/${pageId}/children`);
    blocksUrl.searchParams.set('page_size', '100');
    if (cursor) blocksUrl.searchParams.set('start_cursor', cursor);

    const blocksResp = await fetch(blocksUrl.toString(), {
      headers: { 'Authorization': `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
    });

    if (!blocksResp.ok) {
      const err = await blocksResp.text();
      return new Response(JSON.stringify({ error: 'Notion API error', detail: err }), {
        status: blocksResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const data = await blocksResp.json();
    allBlocks.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  // Extract text from blocks
  const lines = allBlocks.map(block => {
    const type = block.type;
    const content = block[type];
    if (!content) return '';
    if (content.rich_text) {
      const text = content.rich_text.map(t => t.plain_text).join('');
      if (type === 'heading_1') return `# ${text}`;
      if (type === 'heading_2') return `## ${text}`;
      if (type === 'heading_3') return `### ${text}`;
      if (type === 'bulleted_list_item') return `- ${text}`;
      if (type === 'numbered_list_item') return `1. ${text}`;
      if (type === 'to_do') return `- [${content.checked ? 'x' : ' '}] ${text}`;
      if (type === 'quote' || type === 'callout') return `> ${text}`;
      return text;
    }
    if (type === 'child_page') return `[Page: ${content.title || ''}]`;
    if (type === 'divider') return '---';
    if (type === 'code') return '```\n' + (content.rich_text || []).map(t => t.plain_text).join('') + '\n```';
    return '';
  }).filter(line => line !== '');

  return new Response(JSON.stringify({ title, text: lines.join('\n'), block_count: allBlocks.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// === Foresight Question Handler (Miratuku News) ===
async function handleForesight(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const userId = request.headers.get('X-User-Id') || 'unknown';
  if (!checkForesightRateLimit(userId)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded (max 5/min).' }), {
      status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const { question, claContext, signalsContext, newsContext } = body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return new Response(JSON.stringify({ error: 'question is required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const prompt = `あなたは未来洞察の専門家です。以下のデータを基に、ユーザーの問いかけに対して深い洞察を提供してください。

## 基盤データ
${claContext || '（CLA分析データなし）'}
${signalsContext || '（シグナルデータなし）'}
${newsContext || '（ニュースデータなし）'}

## ユーザーの問いかけ
${question.trim().slice(0, 2000)}

## 回答指針
- 因果階層分析の4層（リタニー、社会的原因、ディスコース、神話/メタファー）の観点から回答
- 注目すべきシグナルとの関連を示す
- 未来の可能性について複数のシナリオを提示
- 日本語で回答`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: 'Anthropic API error', detail: data }), {
      status: resp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const answer = data.content?.map(b => b.text || '').join('') || '';
  return new Response(JSON.stringify({ answer, model: data.model, usage: data.usage }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// === Foresight Builder (Miratuku News) ===
async function handleForesightBuilder(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const userId = request.headers.get('X-User-Id') || 'unknown';
  if (!checkForesightRateLimit(userId)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded (max 5/min).' }), {
      status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const { bookmarks } = body;
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
    return new Response(JSON.stringify({ error: 'bookmarks array required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const list = bookmarks.slice(0, 50).map((b, i) => `${i + 1}. [${b.category || 'N/A'}] ${b.title}`).join('\n');
  const prompt = `あなたは未来洞察の専門家であり、因果階層分析（CLA）のスペシャリストです。
以下のブックマークされた資料群を基に、横断的な未来洞察を生成してください。

## ブックマークされた資料
${list}

## タスク
1. CLA対比分析: 4層（リタニー、社会的原因、ディスコース、神話/メタファー）で整理
2. 横断テーマ: 共通する深層テーマやパターンを抽出
3. 注目シグナル: 弱いシグナルや新興トレンドを提案
4. シナリオ: 2-3の未来シナリオを描写

日本語で回答してください。`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    return new Response(JSON.stringify({ error: 'Anthropic API error', detail: data }), {
      status: resp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const insight = data.content?.map(b => b.text || '').join('') || '';
  return new Response(JSON.stringify({ insight, model: data.model, usage: data.usage, bookmarkCount: bookmarks.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// === URL Content Fetcher (replaces CORS proxies) ===
async function handleFetchUrl(request, env, url, corsHeaders) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'url parameter is required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Block internal/private URLs
  try {
    const parsed = new URL(targetUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.startsWith('127.') || hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') || hostname.endsWith('.local') || hostname.startsWith('172.')) {
      return new Response(JSON.stringify({ error: 'Internal URLs not allowed' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Rate limit URL fetches
  const userId = request.headers.get('X-User-Id') || 'fetch';
  if (!checkRateLimit('fetch_' + userId)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const resp = await fetch(targetUrl, {
      headers: { 'User-Agent': 'FutureInsightWorkspace/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `HTTP ${resp.status}` }), {
        status: resp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const html = await resp.text();
    // Return raw HTML - client will parse it
    return new Response(JSON.stringify({ html, url: targetUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
