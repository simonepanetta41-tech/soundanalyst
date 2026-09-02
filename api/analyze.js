import { createClient } from '@supabase/supabase-js';

const PLAN_LIMITS = { free: 3, pro: 20 };

export const config = { maxDuration: 180 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Non autorizzato' });
  const token = authHeader.replace('Bearer ', '');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Token non valido' });

  // Quota consumata in modo atomico lato DB: evita la race condition
  // di leggi-count / scrivi-count+1 su richieste concorrenti.
  const today = new Date().toISOString().split('T')[0];
  const { data: quota, error: quotaErr } = await sb.rpc('consume_analysis_quota', {
    p_user_id: user.id, p_date: today, p_limit: PLAN_LIMITS.free
  });
  if (quotaErr) return res.status(500).json({ error: 'Errore verifica quota: ' + quotaErr.message });
  const q = Array.isArray(quota) ? quota[0] : quota;
  if (!q?.allowed) {
    const lim = PLAN_LIMITS[q?.plan] || PLAN_LIMITS.free;
    return res.status(429).json({ error: `Limite giornaliero raggiunto (${lim} analisi/giorno).` });
  }

  const { messages, system, model, max_tokens } = req.body;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model || 'claude-sonnet-4-6', max_tokens: max_tokens || 16000, temperature: 0, system, messages })
  });
  const data = await resp.json();
  if (!resp.ok) return res.status(resp.status).json({ error: data.error?.message || 'API error' });
  return res.status(200).json(data);
}
