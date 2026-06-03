import type { CompanyId } from './data'

// The crowdsourced report vocabulary. Kept in sync with the DB check
// constraints in supabase/migrations and the Edge Function allow-lists.

export type ProviderId =
  | 'codex'
  | 'claude-code'
  | 'chatgpt'
  | 'claude-ai'
  | 'openai-api'
  | 'claude-api'

export type SymptomId = 'slow' | 'errors' | 'limits' | 'no-reset' | 'quality' | 'down'

// One-tap reporting: a single "I'm having a problem" signal, no symptom picker.
export const ONE_TAP_SYMPTOM: SymptomId = 'down'

export type ProviderDef = {
  id: ProviderId
  label: string
  company: CompanyId
  product: string // matches a string in companies[].products, for corroboration
  primary: boolean // hero card in v1
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'codex', label: 'Codex', company: 'openai', product: 'Codex', primary: true },
  { id: 'claude-code', label: 'Claude Code', company: 'anthropic', product: 'Claude Code', primary: true },
  { id: 'chatgpt', label: 'ChatGPT', company: 'openai', product: 'ChatGPT', primary: false },
  { id: 'claude-ai', label: 'Claude.ai', company: 'anthropic', product: 'Claude.ai', primary: false },
  { id: 'openai-api', label: 'OpenAI API', company: 'openai', product: 'OpenAI API', primary: false },
  { id: 'claude-api', label: 'Claude API', company: 'anthropic', product: 'Claude API', primary: false },
]

export const SYMPTOMS: { id: SymptomId; label: string }[] = [
  { id: 'slow', label: 'Slow' },
  { id: 'errors', label: 'Errors' },
  { id: 'limits', label: 'Limits drained' },
  { id: 'no-reset', label: 'No reset' },
  { id: 'quality', label: 'Quality worse' },
]

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id)
export const SYMPTOM_IDS = SYMPTOMS.map((s) => s.id)

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export function symptomLabel(id: string): string {
  return SYMPTOMS.find((s) => s.id === id)?.label ?? id
}

// Shape returned by the report_stats() Postgres function (aggregates only).
export type ReportStat = {
  provider: ProviderId
  count_1h: number
  count_24h: number
  symptom_breakdown: Record<string, number>
  hourly_buckets: { t: string; c: number }[]
}
