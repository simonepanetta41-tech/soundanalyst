import { createClient } from '@supabase/supabase-js';

const PLAN_LIMITS = { free: 3, pro: 20 };

export async function validateAndLimit(req) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Non autorizzato', status: 401 };
  }

  const token = authHeader.replace('Bearer ', '');
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Verify user token
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return { error: 'Token non valido', status: 401 };
  }

  // Get or create usage record for today
  const today = new Date().toISOString().split('T')[0];
  const { data: usage, error: usageErr } = await sb
    .from('usage_limits')
    .select('analyses_count, plan')
    .eq('user_id', user.id)
    .eq('date', today)
    .single();

  const plan = usage?.plan || 'free';
  const count = usage?.analyses_count || 0;
  const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  if (count >= limit) {
    return {
      error: `Limite giornaliero raggiunto (${limit} analisi/giorno). ${plan === 'free' ? 'Passa a Pro per 20 analisi/giorno!' : ''}`,
      status: 429
    };
  }

  return { user, sb, count, plan, today };
}

export async function incrementUsage(sb, userId, today) {
  await sb.from('usage_limits').upsert({
    user_id: userId,
    date: today,
    analyses_count: 1
  }, {
    onConflict: 'user_id,date',
    ignoreDuplicates: false
  });
  // Increment
  await sb.rpc('increment_analyses_count', { p_user_id: userId, p_date: today });
}
