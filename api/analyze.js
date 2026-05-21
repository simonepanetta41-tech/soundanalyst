import { createClient } from '@supabase/supabase-js';

const PLAN_LIMITS = { free: 3, pro: 20 };

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Auth check
  const auth = await validateUser(req);
  if (auth.error) return json({ error: auth.error }, auth.status);

  // Rate limit check
  const limit = await checkAndIncrement(auth.sb, auth.user.id);
  if (limit.error) return json({ error: limit.error }, 429);

  // Parse request body
  const body = await req.json();
  const { messages, system, model, max_tokens } = body;

  // Call Anthropic
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 16000,
      system,
      messages
    })
  });

  const data = await resp.json();
  if (!resp.ok) return json({ error: data.error?.message || 'API error' }, resp.status);

  return json(data);
}

async function validateUser(req) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return { error: 'Non autorizzato', status: 401 };
  const token = authHeader.replace('Bearer ', '');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return { error: 'Token non valido', status: 401 };
  return { user, sb };
}

async function checkAndIncrement(sb, userId) {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await sb.from('usage_limits').select('analyses_count, plan').eq('user_id', userId).eq('date', today).single();
  const plan = data?.plan || 'free';
  const count = data?.analyses_count || 0;
  const limit = PLAN_LIMITS[plan] || 3;
  if (count >= limit) return { error: `Limite giornaliero raggiunto (${limit} analisi/giorno).${plan === 'free' ? ' Passa a Pro per 20 analisi/giorno!' : ''}` };
  // Increment
  await sb.from('usage_limits').upsert({ user_id: userId, date: today, analyses_count: count + 1, plan }, { onConflict: 'user_id,date' });
  return { ok: true, remaining: limit - count - 1 };
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
