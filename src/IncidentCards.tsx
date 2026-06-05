import { useState } from 'react'
import {
  cardTrafficDisplay,
  historyChip,
  liveStatusNote,
  rankProviderReads,
  TIER_COPY,
  type ProviderLiveRead,
} from './incident-model'
import { ONE_TAP_SYMPTOM, providerById, RESET_SYMPTOM, type ProviderId, type SymptomId } from './reports'
import { isConfigured, submitReport } from './supabase'

type ReportState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done' }
  | { kind: 'cooldown' }
  | { kind: 'error' }

function Sparkline({ buckets }: { buckets: { t: string; c: number }[] }) {
  const counts = buckets.length > 0 ? buckets.map((b) => b.c) : Array.from({ length: 24 }, () => 0)
  const max = Math.max(1, ...counts)
  const peak = Math.max(...counts)
  return (
    <div className="ic-spark-wrap">
      <div className="spark-bars" aria-hidden="true">
        {counts.map((c, i) => (
          <span
            key={i}
            className={c > 0 ? 'on' : ''}
            style={{ height: `${c > 0 ? Math.max(22, (c / max) * 100) : 8}%` }}
          />
        ))}
      </div>
      <span className="ic-spark-label">
        {peak > 0 ? `Peak ${peak} reports/hr` : 'No report burst in 24h'}
      </span>
    </div>
  )
}

type Props = {
  reads: ProviderLiveRead[]
  corroboration: Partial<Record<ProviderId, string>>
  loading: boolean
  onSubmitted: () => void
}

export function IncidentCards({ reads, corroboration, loading, onSubmitted }: Props) {
  const [reportState, setReportState] = useState<Partial<Record<ProviderId, ReportState>>>({})
  const [resetState, setResetState] = useState<Partial<Record<ProviderId, ReportState>>>({})

  async function send(
    provider: ProviderId,
    symptom: SymptomId,
    setState: React.Dispatch<React.SetStateAction<Partial<Record<ProviderId, ReportState>>>>,
  ) {
    setState((prev) => ({ ...prev, [provider]: { kind: 'sending' } }))
    const result = await submitReport(provider, symptom)
    if (result.ok) {
      setState((prev) => ({ ...prev, [provider]: { kind: 'done' } }))
      onSubmitted()
    } else if (result.error === 'cooldown') {
      setState((prev) => ({ ...prev, [provider]: { kind: 'cooldown' } }))
    } else {
      setState((prev) => ({ ...prev, [provider]: { kind: 'error' } }))
    }
  }

  function submitProblem(provider: ProviderId) {
    if (reportState[provider]?.kind === 'sending') return
    return send(provider, ONE_TAP_SYMPTOM, setReportState)
  }

  function reportReset(provider: ProviderId) {
    if (resetState[provider]?.kind === 'sending') return
    return send(provider, RESET_SYMPTOM, setResetState)
  }

  function resetLabel(state: ReportState | undefined): string {
    switch (state?.kind) {
      case 'sending': return 'Sending…'
      case 'done': return 'Reset logged ✓'
      case 'cooldown': return 'Already logged · try later'
      case 'error': return 'Try again'
      default: return 'My limits just reset ✅'
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
      {rankProviderReads(reads).map((read) => {
        const { providerId, stat, report: reportRead } = read
        const incidentName = corroboration[providerId]
        const reportTier = reportRead.tier
        const note = liveStatusNote(read, incidentName)
        const traffic = cardTrafficDisplay(stat, reportTier)
        const history = historyChip(stat)
        const pain = read.pain
        const rState = reportState[providerId]
        const done = rState?.kind === 'done' || rState?.kind === 'cooldown'
        const resetRState = resetState[providerId]
        const resetDone = resetRState?.kind === 'done' || resetRState?.kind === 'cooldown'
        const resetReports = Number(stat.symptom_breakdown?.[RESET_SYMPTOM] ?? 0)
        const label = providerById(providerId)?.label ?? providerId

        return (
          <article className={`incident-card tier-${reportTier}`} key={providerId}>
            <div className="ic-top">
              <div className="ic-id">
                <span className="ic-dot" aria-hidden="true" />
                <div>
                  <h3>{label}</h3>
                  <span className="ic-tier">{TIER_COPY[reportTier].label}</span>
                </div>
              </div>
              <div className={`ic-rate${reportTier === 'normal' ? ' quiet' : ''}`}>
                <b>{loading ? '—' : traffic.value}</b>
                <small>{traffic.label}</small>
                <span className="ic-rate-hint">{traffic.hint}</span>
              </div>
            </div>

            <div className={`ic-spark tier-${reportTier}`}>
              <Sparkline buckets={stat.hourly_buckets} />
            </div>

            <div className="ic-meta">
              {pain != null && pain >= 58 && (
                <span className="ic-pain-chip">Pain {pain}/100</span>
              )}
              {history && <span className="ic-history-chip">{history}</span>}
            </div>

            {note && <p className="ic-note">{note}</p>}

            <button
              type="button"
              className="ic-report"
              disabled={!isConfigured || rState?.kind === 'sending' || done}
              onClick={() => submitProblem(providerId)}
            >
              {reportLabel(rState)}
            </button>

            <button
              type="button"
              className="ic-report reset"
              disabled={!isConfigured || resetRState?.kind === 'sending' || resetDone}
              onClick={() => reportReset(providerId)}
            >
              {resetLabel(resetRState)}
            </button>

            {resetReports > 0 && (
              <p className="ic-badge reset-confirmed">{resetReports} reset {resetReports === 1 ? 'report' : 'reports'} in the last hour</p>
            )}

            {incidentName && !note?.startsWith('Official incident') && (
              <p className="ic-badge corroborated">Cross-checked: {incidentName}</p>
            )}
          </article>
        )
      })}
    </div>
  )
}
