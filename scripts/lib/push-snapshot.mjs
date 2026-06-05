import { createClient } from '@supabase/supabase-js'

// Appends a generated snapshot to the public.signal_snapshots table so the live
// site can read it without committing churn into git. Reads credentials at call
// time: when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent (local dev), it
// no-ops so `npm run fetch:data` still produces the static files offline. The
// service-role key is only ever set server-side (GitHub Actions secret).
//
// Never throws — a database hiccup must not fail the whole fetch run; callers get
// a result object and the local file write still happens.
export async function pushSnapshot(kind, snapshot) {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.warn(`[push-snapshot] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping ${kind} upload`)
    return { ok: false, skipped: true }
  }

  try {
    const client = createClient(url, serviceKey, { auth: { persistSession: false } })
    const { error } = await client.from('signal_snapshots').insert({
      kind,
      generated_at: snapshot.generated_at,
      payload: snapshot,
    })
    if (error) {
      console.error(`[push-snapshot] ${kind} insert failed:`, error.message)
      return { ok: false, error: error.message }
    }
    console.log(`[push-snapshot] uploaded ${kind} snapshot`)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[push-snapshot] ${kind} upload threw:`, message)
    return { ok: false, error: message }
  }
}
