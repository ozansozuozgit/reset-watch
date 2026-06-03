// AI Down Detector — submit-report Edge Function
// Validates a one-tap report, hashes the client IP, enforces a per-device /
// per-IP cooldown, and inserts via the service role. The browser never touches
// the table directly (RLS deny-all); this function is the only write path.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const PROVIDERS = ['codex', 'claude-code', 'chatgpt', 'claude-ai', 'openai-api', 'claude-api']
const SYMPTOMS = ['slow', 'errors', 'limits', 'no-reset', 'quality', 'down']
const COOLDOWN_MINUTES = 20

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// device_id is client-supplied; only accept a safe opaque token so it can't be
// abused (and is safe to interpolate into a PostgREST filter).
function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{16,64}$/i.test(value)
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let payload: { provider?: string; symptom?: string; device_id?: string }
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'bad_json' }, 400)
  }

  const { provider, symptom, device_id } = payload
  if (!provider || !PROVIDERS.includes(provider)) return json({ error: 'bad_provider' }, 400)
  if (!symptom || !SYMPTOMS.includes(symptom)) return json({ error: 'bad_symptom' }, 400)
  if (!validDeviceId(device_id)) return json({ error: 'bad_device_id' }, 400)

  const salt = Deno.env.get('IP_HASH_SALT') ?? ''
  const ipHash = await sha256(clientIp(req) + salt)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  const cutoff = new Date(Date.now() - COOLDOWN_MINUTES * 60_000).toISOString()
  const { data: recent, error: lookupError } = await supabase
    .from('reports')
    .select('id')
    .eq('provider', provider)
    .or(`device_id.eq.${device_id},ip_hash.eq.${ipHash}`)
    .gte('created_at', cutoff)
    .limit(1)

  if (lookupError) return json({ error: 'lookup_failed' }, 500)
  if (recent && recent.length > 0) {
    return json({ error: 'cooldown', retry_after_minutes: COOLDOWN_MINUTES }, 429)
  }

  const { error: insertError } = await supabase
    .from('reports')
    .insert({ provider, symptom, device_id, ip_hash: ipHash })

  if (insertError) return json({ error: 'insert_failed' }, 500)
  return json({ ok: true })
})
