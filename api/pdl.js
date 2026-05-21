export const config = { runtime: 'edge' };

const PLAN_LIMITS = { free: 3, pro: 20 };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Non autorizzato' }, 401);

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error } = await sb.auth.getUser(authHeader.replace('Bearer ', ''));
  if (error || !user) return json({ error: 'Token non valido' }, 401);

  // Check rate limit
  const today = new Date().toISOString().split('T')[0];
  const { data } = await sb.from('usage_limits').select('analyses_count, plan').eq('user_id', user.id).eq('date', today).single();
  const plan = data?.plan || 'free';
  const count = data?.analyses_count || 0;
  const limit = PLAN_LIMITS[plan] || 3;
  if (count >= limit) return json({ error: `Limite giornaliero raggiunto (${limit} analisi/giorno).${plan === 'free' ? ' Passa a Pro per 20 analisi/giorno!' : ''}` }, 429);

  // Increment
  await sb.from('usage_limits').upsert({ user_id: user.id, date: today, analyses_count: count + 1, plan }, { onConflict: 'user_id,date' });

  const body = await req.json();
  const { messages, system, max_tokens } = body;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: max_tokens || 16000,
      system,
      messages
    })
  });

  const data2 = await resp.json();
  if (!resp.ok) return json({ error: data2.error?.message || 'API error' }, resp.status);
  return json(data2);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}
