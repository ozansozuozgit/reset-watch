import { createClient } from '@supabase/supabase-js'

// Persistence for the monthly Tavily credit counter (public.tavily_usage).
// Uses the service-role key (server-side only). Never throws — a DB hiccup or a
// not-yet-applied migration must not break the fetch run; on any failure read
// returns 0 (so the cadence still bounds spend) and write is a no-op. The pure
// budget math (withinBudget) and month key live in ./tavily.mjs.

function serviceClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function readTavilyUsage(month) {
  const client = serviceClient()
  if (!client) return 0
  try {
    const { data, error } = await client.from('tavily_usage').select('credits').eq('month', month).maybeSingle()
    if (error) {
      console.warn('[tavily-budget] read failed (cap not enforced this run):', error.message)
      return 0
    }
    return data?.credits ?? 0
  } catch (error) {
    console.warn('[tavily-budget] read threw:', error instanceof Error ? error.message : String(error))
    return 0
  }
}

export async function writeTavilyUsage(month, credits) {
  const client = serviceClient()
  if (!client) return
  try {
    const { error } = await client
      .from('tavily_usage')
      .upsert({ month, credits, updated_at: new Date().toISOString() }, { onConflict: 'month' })
    if (error) console.warn('[tavily-budget] write failed:', error.message)
  } catch (error) {
    console.warn('[tavily-budget] write threw:', error instanceof Error ? error.message : String(error))
  }
}
