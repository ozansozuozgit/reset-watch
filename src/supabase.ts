import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { ProviderId, ReportStat, SymptomId } from './reports'

// All Supabase I/O lives here. Consumers never touch the client directly.
// When env vars are absent the app runs in read-only "demo" mode so local dev
// (and the build) works without credentials.

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && anonKey)

let client: SupabaseClient | null = null
if (isConfigured) {
  client = createClient(url!, anonKey!, { auth: { persistSession: false } })
}

const DEVICE_KEY = 'add_device_id'

function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    // localStorage blocked (private mode) — fall back to an ephemeral id.
    return crypto.randomUUID()
  }
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; error: 'cooldown' | 'network' | 'rejected' | 'not_configured'; retryAfterMinutes?: number }

export async function submitReport(provider: ProviderId, symptom: SymptomId): Promise<SubmitResult> {
  if (!client) return { ok: false, error: 'not_configured' }
  try {
    const { data, error } = await client.functions.invoke('submit-report', {
      body: { provider, symptom, device_id: deviceId() },
    })
    if (error) {
      // functions.invoke surfaces non-2xx as an error; inspect the body.
      const ctx = (error as { context?: Response }).context
      if (ctx && typeof ctx.json === 'function') {
        try {
          const body = await ctx.json()
          if (body?.error === 'cooldown') {
            return { ok: false, error: 'cooldown', retryAfterMinutes: body.retry_after_minutes }
          }
        } catch {
          // fall through
        }
      }
      return { ok: false, error: 'rejected' }
    }
    if (data?.ok) return { ok: true }
    return { ok: false, error: 'rejected' }
  } catch {
    return { ok: false, error: 'network' }
  }
}

export async function fetchReportStats(): Promise<ReportStat[]> {
  if (!client) return []
  const { data, error } = await client.rpc('report_stats')
  if (error || !data) return []
  return data as ReportStat[]
}

// Latest generated snapshot for a kind (issue #2). Returns null when Supabase is
// unconfigured or empty so callers fall back to the static /data file.
export type SnapshotKind = 'social' | 'status' | 'auto-resets'

export async function fetchSnapshot<T>(kind: SnapshotKind): Promise<T | null> {
  if (!client) return null
  const { data, error } = await client.rpc('latest_snapshot', { p_kind: kind })
  if (error || !data) return null
  return data as T
}
