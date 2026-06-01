import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { companies, events as seedEvents, failurePoints, watchlistSignals } from './data'
import { liveEventsFromSnapshot, loadJson, mergeEvents, type ResetFeed, type StatusSnapshot } from './live'
import { attribution, buildPredictions, eventResetProbability, lagHours, metrics } from './model'

function fmtDate(value?: string) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value))
}

function scoreTone(score: number) {
  if (score >= 78) return 'hot'
  if (score >= 58) return 'likely'
  if (score >= 35) return 'watch'
  return 'low'
}

function App() {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null)
  const [resetFeed, setResetFeed] = useState<ResetFeed | null>(null)

  useEffect(() => {
    Promise.all([
      loadJson<StatusSnapshot>('/data/status-snapshot.json'),
      loadJson<ResetFeed>('/data/resets.json'),
    ]).then(([statusSnapshot, resets]) => {
      setSnapshot(statusSnapshot)
      setResetFeed(resets)
    })
  }, [])

  const liveEvents = useMemo(() => liveEventsFromSnapshot(snapshot, resetFeed), [snapshot, resetFeed])
  const events = useMemo(() => mergeEvents(seedEvents, liveEvents), [liveEvents])
  const stat = useMemo(() => metrics(events), [events])
  const predictions = useMemo(() => buildPredictions(events), [events])
  const recentLiveEvents = liveEvents.slice().sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp)).slice(0, 8)

  return (
    <main>
      <section className="hero">
        <div className="eyebrow"><span /> Reset Watch · Claude Code + Codex</div>
        <div className="hero-grid">
          <div>
            <h1>Usage reset radar for AI coding tools.</h1>
            <p className="lede">
              Track coding-tool incidents, match them to public make-good resets, and estimate whether Anthropic or OpenAI is likely to reset usage next.
            </p>
            <div className="hero-actions">
              <a href="#predictions">Current forecast</a>
              <a className="ghost" href="#live-incidents">Live incidents</a>
              <a className="ghost" href="#failure-points">Failure points</a>
            </div>
          </div>
          <div className="signal-card" aria-label="Make-good metrics">
            <p className="card-label">Live status</p>
            <strong>{snapshot ? recentLiveEvents.length : '—'}</strong>
            <span>matched coding/usage incidents from public status feeds.</span>
            <div className="mini-stats">
              <div><b>{stat.usageMakeGoodRate}%</b><small>usage reset rate</small></div>
              <div><b>{resetFeed?.resets.length ?? '—'}</b><small>known resets</small></div>
              <div><b>{stat.medianLag ?? '—'}h</b><small>median lag</small></div>
            </div>
            <p className="freshness">Last checked: {fmtDate(snapshot?.generated_at)}</p>
          </div>
        </div>
      </section>

      <section id="predictions" className="section">
        <div className="section-heading">
          <p className="card-label">Forecast</p>
          <h2>Next reset likelihood</h2>
          <p>Computed from live status incidents plus curated reset announcements. Quota/metering incidents matter more than generic outages.</p>
        </div>
        <div className="prediction-grid">
          {predictions.map((prediction) => (
            <article className={`prediction ${prediction.label}`} key={prediction.company}>
              <div className="prediction-top">
                <div>
                  <p className="card-label">{prediction.companyLabel}</p>
                  <h3>{prediction.label.toUpperCase()}</h3>
                </div>
                <div className="score-ring" style={{ '--score': `${prediction.score}%` } as React.CSSProperties}>
                  <b>{prediction.score}</b>
                  <span>/100</span>
                </div>
              </div>
              <p className="window">{prediction.nextWindow}</p>
              <div className="drivers">
                <b>Drivers</b>
                <ul>{prediction.drivers.map((driver) => <li key={driver}>{driver}</li>)}</ul>
              </div>
              <div className="blockers">
                <b>Why this can be wrong</b>
                <ul>{prediction.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="live-incidents" className="section">
        <div className="section-heading">
          <p className="card-label">Live incidents</p>
          <h2>Status feed matches</h2>
          <p>Hourly GitHub Actions cron fetches Anthropic/OpenAI status APIs, commits changes, and Vercel redeploys from GitHub.</p>
        </div>
        <div className="live-meta">
          <span>Status snapshot: {snapshot ? fmtDate(snapshot.generated_at) : 'loading or missing'}</span>
          <span>Sources: {snapshot?.sources.map((source) => source.name).join(', ') || '—'}</span>
          <span>Errors: {snapshot?.errors.length ?? 0}</span>
        </div>
        <div className="timeline compact">
          {recentLiveEvents.length ? recentLiveEvents.map((event) => {
            const probability = eventResetProbability(event)
            return (
              <article className="event" key={event.id}>
                <div className="event-date">{fmtDate(event.timestamp)}</div>
                <div className="event-body">
                  <div className="event-title-row">
                    <h3>{event.title}</h3>
                    <span className={`pill ${scoreTone(probability)}`}>{probability}% reset-fit</span>
                  </div>
                  <p>{event.userImpact}</p>
                  <div className="tags">
                    <span>{event.companyLabel}</span>
                    <span>{event.product}</span>
                    <span>{event.kind}</span>
                    <span>{event.resetIssued ? 'matched reset' : 'no matched reset'}</span>
                  </div>
                </div>
              </article>
            )
          }) : (
            <article className="empty-state">
              <h3>No live matches loaded yet</h3>
              <p>Run <code>npm run fetch:status</code>, or wait for the hourly GitHub Action after pushing the repo.</p>
            </article>
          )}
        </div>
      </section>

      <section className="section split">
        <div>
          <p className="card-label">Method</p>
          <h2>What the model watches</h2>
          <p className="muted">The strongest trigger is a root-caused bug that depleted paid limits incorrectly. General errors are weak signals.</p>
        </div>
        <ol className="signal-list">
          {watchlistSignals.map((signal) => <li key={signal}>{signal}</li>)}
        </ol>
      </section>

      <section className="section">
        <div className="section-heading">
          <p className="card-label">Evidence ledger</p>
          <h2>Known reset examples</h2>
          <p>Curated examples stay in the repo; live incidents are merged in above for current forecasting.</p>
        </div>
        <div className="timeline">
          {seedEvents.map((event) => {
            const probability = eventResetProbability(event)
            return (
              <article className="event" key={event.id}>
                <div className="event-date">{fmtDate(event.timestamp)}</div>
                <div className="event-body">
                  <div className="event-title-row">
                    <h3>{event.title}</h3>
                    <span className={`pill ${scoreTone(probability)}`}>{probability}% reset-fit</span>
                  </div>
                  <p>{event.userImpact}</p>
                  <div className="tags">
                    <span>{event.companyLabel}</span>
                    <span>{event.product}</span>
                    <span>{event.kind}</span>
                    <span>{event.evidence} evidence</span>
                    <span>{attribution(event)} attribution</span>
                    {event.resetIssued && <span>reset lag: {lagHours(event) ?? 'unknown'}h</span>}
                  </div>
                  <p className="notes">{event.notes}</p>
                  {event.sourceUrl && <a className="source" href={event.sourceUrl} target="_blank">Source: {event.sourceLabel}</a>}
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section id="failure-points" className="section">
        <div className="section-heading">
          <p className="card-label">Failure analysis</p>
          <h2>Ways the forecast breaks</h2>
          <p>This is the part that keeps the site honest on GitHub/Vercel.</p>
        </div>
        <div className="failure-grid">
          {failurePoints.map((point) => (
            <article className="failure" key={point.title}>
              <h3>{point.title}</h3>
              <p>{point.detail}</p>
              <small>{point.mitigation}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="section companies">
        {companies.map((company) => (
          <article key={company.id}>
            <p className="card-label">{company.name}</p>
            <h3>{company.products.join(' · ')}</h3>
            <p>Signal quality: {company.publicSignalQuality}/100</p>
            <p>Watch: {company.resetChannels.join(', ')}</p>
            <a href={company.statusUrl} target="_blank">{company.statusUrl}</a>
          </article>
        ))}
      </section>
    </main>
  )
}

export default App
