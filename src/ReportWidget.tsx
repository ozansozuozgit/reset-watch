import { useState } from 'react'
import { PROVIDERS, SYMPTOMS, type ProviderId, type SymptomId } from './reports'
import { isConfigured, submitReport } from './supabase'

type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done' }
  | { kind: 'cooldown'; minutes?: number }
  | { kind: 'error'; message: string }

export function ReportWidget({ onSubmitted }: { onSubmitted: () => void }) {
  const [provider, setProvider] = useState<ProviderId>('codex')
  const [symptom, setSymptom] = useState<SymptomId | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function send() {
    if (!symptom || status.kind === 'sending') return
    setStatus({ kind: 'sending' })
    const result = await submitReport(provider, symptom)
    if (result.ok) {
      setStatus({ kind: 'done' })
      setSymptom(null)
      onSubmitted()
      return
    }
    if (result.error === 'cooldown') {
      setStatus({ kind: 'cooldown', minutes: result.retryAfterMinutes })
    } else if (result.error === 'not_configured') {
      setStatus({ kind: 'error', message: 'Reporting is not live yet in this environment.' })
    } else {
      setStatus({ kind: 'error', message: 'Could not send — check your connection and try again.' })
    }
  }

  return (
    <div className="report-widget" aria-label="Report a problem">
      <div className="rw-head">
        <p className="card-label">See a problem right now?</p>
        <h3>Report it in one tap</h3>
        <p className="rw-sub">Anonymous. One report per tool every 20 minutes keeps the signal honest.</p>
      </div>

      <label className="rw-field">
        <span>Which tool?</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>

      <div className="rw-field">
        <span>What's wrong?</span>
        <div className="rw-chips">
          {SYMPTOMS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`rw-chip ${symptom === s.id ? 'on' : ''}`}
              aria-pressed={symptom === s.id}
              onClick={() => { setSymptom(s.id); setStatus({ kind: 'idle' }) }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="rw-submit"
        disabled={!symptom || status.kind === 'sending'}
        onClick={send}
      >
        {status.kind === 'sending' ? 'Sending…' : 'Submit report'}
      </button>

      {status.kind === 'done' && <p className="rw-msg ok">Thanks — your report is counted.</p>}
      {status.kind === 'cooldown' && (
        <p className="rw-msg warn">
          You already reported this tool recently. Try again in ~{status.minutes ?? 20} min.
        </p>
      )}
      {status.kind === 'error' && <p className="rw-msg err">{status.message}</p>}
      {!isConfigured && status.kind === 'idle' && (
        <p className="rw-msg warn">Demo mode — reporting goes live once Supabase keys are set.</p>
      )}
    </div>
  )
}
