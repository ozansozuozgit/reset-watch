import { blendCondition, topSymptoms, TIER_COPY, type ConditionDriver } from './incident-model'
import { PROVIDERS, symptomLabel, type ProviderId, type ReportStat } from './reports'

const EMPTY_STAT = (provider: ProviderId): ReportStat => ({
  provider,
  count_1h: 0,
  count_24h: 0,
  symptom_breakdown: {},
  hourly_buckets: [],
})

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
}

export function IncidentCards({ stats, painByProvider, corroboration, loading }: Props) {
  const statByProvider = new Map(stats.map((s) => [s.provider, s]))

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
        const symptoms = topSymptoms(stat, 3)
        const note = driverNote(condition.driver, incidentName)

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

            {note ? (
              <p className="ic-note">{note}</p>
            ) : symptoms.length > 0 ? (
              <div className="ic-symptoms">
                {symptoms.map((s) => (
                  <span key={s.id} className="ic-symptom">{symptomLabel(s.id)} <b>{s.count}</b></span>
                ))}
              </div>
            ) : (
              <p className="ic-quiet">No reports in the last hour.</p>
            )}

            <p className={`ic-badge ${incidentName ? 'corroborated' : 'user-only'}`}>
              {incidentName ? `Cross-checked: ${incidentName}` : 'Community-reported'}
            </p>
          </article>
        )
      })}
    </div>
  )
}
