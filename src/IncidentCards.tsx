import { deriveStatus, topSymptoms, TIER_COPY, type StatusTier } from './incident-model'
import { PROVIDERS, symptomLabel, type ProviderId, type ReportStat } from './reports'

const EMPTY_STAT = (provider: ProviderId): ReportStat => ({
  provider,
  count_1h: 0,
  count_24h: 0,
  symptom_breakdown: {},
  hourly_buckets: [],
})

function Sparkline({ buckets }: { buckets: { t: string; c: number }[] }) {
  if (buckets.length < 2) return <div className="spark spark-empty" aria-hidden="true" />
  const counts = buckets.map((b) => b.c)
  const max = Math.max(1, ...counts)
  const w = 120
  const h = 28
  const step = w / (counts.length - 1)
  const points = counts
    .map((c, i) => `${(i * step).toFixed(1)},${(h - (c / max) * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

type Props = {
  stats: ReportStat[]
  corroboration: Partial<Record<ProviderId, string>>
  loading: boolean
}

export function IncidentCards({ stats, corroboration, loading }: Props) {
  const statByProvider = new Map(stats.map((s) => [s.provider, s]))
  const cards = PROVIDERS.filter((p) => p.primary).map((p) => {
    const stat = statByProvider.get(p.id) ?? EMPTY_STAT(p.id)
    const read = deriveStatus(stat)
    return { provider: p, stat, read }
  })

  return (
    <div className="incident-cards" aria-label="Live tool status">
      {cards.map(({ provider, stat, read }) => {
        const tier: StatusTier = read.tier
        const tone = TIER_COPY[tier]
        const symptoms = topSymptoms(stat, 3)
        const corroborated = corroboration[provider.id]
        return (
          <article className={`incident-card tier-${tier}`} key={provider.id}>
            <div className="ic-top">
              <div className="ic-id">
                <span className="ic-dot" aria-hidden="true">{tone.dot}</span>
                <div>
                  <h3>{provider.label}</h3>
                  <span className="ic-tier">{tone.label}</span>
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

            {symptoms.length > 0 ? (
              <div className="ic-symptoms">
                {symptoms.map((s) => (
                  <span key={s.id} className="ic-symptom">{symptomLabel(s.id)} <b>{s.count}</b></span>
                ))}
              </div>
            ) : (
              <p className="ic-quiet">No reports in the last hour.</p>
            )}

            <p className={`ic-badge ${corroborated ? 'corroborated' : 'user-only'}`}>
              {corroborated
                ? `Corroborated by official status: ${corroborated}`
                : 'User-reported only'}
            </p>
          </article>
        )
      })}
    </div>
  )
}
