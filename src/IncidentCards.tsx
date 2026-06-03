import { useState } from 'react'
import { blendCondition, TIER_COPY, type ConditionDriver } from './incident-model'
import { ONE_TAP_SYMPTOM, PROVIDERS, type ProviderId, type ReportStat } from './reports'
import { isConfigured, submitReport } from './supabase'

const EMPTY_STAT = (provider: ProviderId): ReportStat => ({
  provider,
  count_1h: 0,
  count_24h: 0,
  symptom_breakdown: {},
  hourly_buckets: [],
})

type ReportState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done' }
  | { kind: 'cooldown' }
  | { kind: 'error' }

// Sparse integer counts read better as bars than a floating line.
function Sparkline({ buckets }: { buckets: { t: string; c: number }[] }) {
  if (buckets.length === 0) {
    return <div className="spark-bars empty" aria-hidden="true" />
  }
  const counts = buckets.map((b) => b.c)
  const max = Math.max(1, ...counts)
  return (
    <div className="spark-bars" aria-hidden="true">
      {counts.map((c, i) => (
        <span
          key={i}
          className={c > 0 ? 'on' : ''}
          style={{ height: `${c > 0 ? Math.max(28, (c / max) * 100) : 14}%` }}
        />
      ))}
    </div>
  )
}

function driverNote(driver: ConditionDriver, incidentName?: string): string | null {
  switch (driver) {
    case 'pain':
      return 'Flagged by community pain'
    case 'incident':
      return incidentName ? `Official incident: ${incidentName}` : 'Official incident active'
    default:
      return null
  }
}

type Props = {
  stats: ReportStat[]
  painByProvider: Partial<Record<ProviderId, number>>
  corroboration: Partial<Record<ProviderId, string>>
  loading: boolean
  onSubmitted: () => void
}

export function IncidentCards({ stats, painByProvider, corroboration, loading, onSubmitted }: Props) {
  const statByProvider = new Map(stats.map((s) => [s.provider, s]))
  const [reportState, setReportState] = useState<Partial<Record<ProviderId, ReportState>>>({})

  async function report(provider: ProviderId) {
    if (reportState[provider]?.kind === 'sending') return
    setReportState((prev) => ({ ...prev, [provider]: { kind: 'sending' } }))
    const result = await submitReport(provider, ONE_TAP_SYMPTOM)
    if (result.ok) {
      setReportState((prev) => ({ ...prev, [provider]: { kind: 'done' } }))
      onSubmitted()
    } else if (result.error === 'cooldown') {
      setReportState((prev) => ({ ...prev, [provider]: { kind: 'cooldown' } }))
    } else {
      setReportState((prev) => ({ ...prev, [provider]: { kind: 'error' } }))
    }
  }

  function reportLabel(state: ReportState | undefined): string {
    switch (state?.kind) {
      case 'sending': return 'Sending…'
      case 'done': return 'Thanks — counted ✓'
      case 'cooldown': return 'Already reported · try later'
      case 'error': return 'Try again'
      default: return isConfigured ? 'Yes, it’s having problems' : 'Reporting goes live soon'
    }
  }

  return (
    <div className="incident-cards" aria-label="Live tool status">
      {PROVIDERS.filter((p) => p.primary).map((provider) => {
        const stat = statByProvider.get(provider.id) ?? EMPTY_STAT(provider.id)
        const incidentName = corroboration[provider.id]
        const condition = blendCondition({
          stat,
          pain: painByProvider[provider.id],
          officialIncident: Boolean(incidentName),
        })
        const tier = condition.tier
        const note = driverNote(condition.driver, incidentName)
        const rState = reportState[provider.id]
        const done = rState?.kind === 'done' || rState?.kind === 'cooldown'

        return (
          <article className={`incident-card tier-${tier}`} key={provider.id}>
            <div className="ic-top">
              <div className="ic-id">
                <span className="ic-dot" aria-hidden="true" />
                <div>
                  <h3>{provider.label}</h3>
                  <span className="ic-tier">{TIER_COPY[tier].label}</span>
                </div>
              </div>
              <div className="ic-rate">
                <b>{loading && stat.count_1h === 0 ? '—' : stat.count_1h}</b>
                <small>reports / hr</small>
              </div>
            </div>

            <div className={`ic-spark tier-${tier}`}>
              <Sparkline buckets={stat.hourly_buckets} />
              <span className="ic-24h">{stat.count_24h} in 24h</span>
            </div>

            {note && <p className="ic-note">{note}</p>}

            <button
              type="button"
              className="ic-report"
              disabled={!isConfigured || rState?.kind === 'sending' || done}
              onClick={() => report(provider.id)}
            >
              {reportLabel(rState)}
            </button>

            {incidentName && <p className="ic-badge corroborated">Cross-checked: {incidentName}</p>}
          </article>
        )
      })}
    </div>
  )
}
