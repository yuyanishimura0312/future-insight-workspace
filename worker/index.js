// Cloudflare Worker: Notion API Proxy
// Fetches Notion page content and returns plain text
// NOTION_TOKEN is set as a secret via `wrangler secret put NOTION_TOKEN`

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
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

    try {
      // Fetch page title
      const pageResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        headers: {
          'Authorization': `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
        }
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
          headers: {
            'Authorization': `Bearer ${env.NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
          }
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
          if (type === 'quote') return `> ${text}`;
          if (type === 'callout') return `> ${text}`;
          if (type === 'toggle') return `${text}`;
          return text;
        }
        if (type === 'child_page') return `[Page: ${content.title || ''}]`;
        if (type === 'divider') return '---';
        if (type === 'code') {
          const code = (content.rich_text || []).map(t => t.plain_text).join('');
          return '```\n' + code + '\n```';
        }
        return '';
      }).filter(line => line !== '');

      const text = lines.join('\n');

      return new Response(JSON.stringify({ title, text, block_count: allBlocks.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
