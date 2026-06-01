import './App.css'
import { companies, events, failurePoints, watchlistSignals } from './data'
import { attribution, buildPredictions, eventResetProbability, lagHours, metrics } from './model'

const stat = metrics(events)
const predictions = buildPredictions(events)

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
  return (
    <main>
      <section className="hero">
        <div className="eyebrow"><span /> Reset Watch · Claude Code + Codex</div>
        <div className="hero-grid">
          <div>
            <h1>Outage-to-apology reset radar for AI coding tools.</h1>
            <p className="lede">
              Track the incidents that burn quota, match them to public make-good resets, and estimate whether Anthropic or OpenAI is likely to reset usage next.
            </p>
            <div className="hero-actions">
              <a href="#predictions">Current forecast</a>
              <a className="ghost" href="#failure-points">Failure points</a>
            </div>
          </div>
          <div className="signal-card" aria-label="Make-good metrics">
            <div className="signal-orbit" />
            <p className="card-label">Observed sample</p>
            <strong>{stat.usageMakeGoodRate}%</strong>
            <span>of usage-related coding incidents in this seed dataset have a public reset.</span>
            <div className="mini-stats">
              <div><b>{stat.codingIncidentCount}</b><small>coding incidents</small></div>
              <div><b>{stat.resetCount}</b><small>resets</small></div>
              <div><b>{stat.medianLag ?? '—'}h</b><small>median lag</small></div>
            </div>
          </div>
        </div>
      </section>

      <section id="predictions" className="section">
        <div className="section-heading">
          <p className="card-label">Forecast</p>
          <h2>Next reset likelihood</h2>
          <p>Scores are deliberately conservative: quota/metering incidents matter much more than generic outages.</p>
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

      <section className="section split">
        <div>
          <p className="card-label">Method</p>
          <h2>What the model watches</h2>
          <p className="muted">The tracker treats “usage reset” as a measurable event, not a vibe. The strongest trigger is a root-caused bug that depleted paid limits incorrectly.</p>
        </div>
        <ol className="signal-list">
          {watchlistSignals.map((signal) => <li key={signal}>{signal}</li>)}
        </ol>
      </section>

      <section className="section">
        <div className="section-heading">
          <p className="card-label">Evidence ledger</p>
          <h2>Seed events</h2>
          <p>Start with hand-curated incidents; later this can ingest status APIs and social posts on a schedule.</p>
        </div>
        <div className="timeline">
          {events.map((event) => {
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
