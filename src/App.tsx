import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { companies, events as seedEvents, failurePoints, watchlistSignals } from './data'
import { liveEventsFromSnapshot, loadJson, mergeEvents, type ResetFeed, type SocialSnapshot, type StatusSnapshot } from './live'
import { attribution, buildPredictions, eventPainScore, eventResetProbability, lagHours, metrics, type Prediction } from './model'
import { IncidentCards } from './IncidentCards'
import { ReportWidget } from './ReportWidget'
import { fetchReportStats } from './supabase'
import { blendCondition, tierIsWorse, type StatusTier } from './incident-model'
import { PROVIDERS, type ProviderId, type ReportStat } from './reports'

const STATS_POLL_MS = 45_000

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

function confidenceCopy(label: Prediction['label']) {
  if (label === 'hot') return 'reset pressure is visible'
  if (label === 'likely') return 'watch reset channels closely'
  if (label === 'watch') return 'needs stronger usage evidence'
  return 'background monitoring only'
}

function painCopy(label: Prediction['painLabel']) {
  if (label === 'burning') return 'users are loudly feeling it'
  if (label === 'degraded') return 'degradation chatter is elevated'
  if (label === 'noticeable') return 'some pain is visible'
  return 'community signal is quiet'
}

function sourceSummary(sources?: Record<string, number>) {
  if (!sources) return 'Public status + community watch'
  const labels: Record<string, string> = {
    hn: 'developer forums',
    'x-search-snippet': 'public posts',
    'reddit-search-snippet': 'community threads',
    'bluesky-search-snippet': 'social posts',
  }
  const visible = Object.entries(sources).filter(([, count]) => count > 0)
  return visible.map(([name, count]) => `${labels[name] ?? name} ${count}`).join(' · ') || 'Observed chatter spike'
}

function communityBasis(volume: number, heat: number) {
  if (volume > 0) return `${volume} public matches · directional signal`
  if (heat >= 58) return 'Elevated chatter · verified signal'
  return 'No clear public wave detected'
}

function exampleSourceLabel(source: string) {
  const labels: Record<string, string> = {
    hn: 'Forum mention',
    'x-search-snippet': 'Public post',
    'reddit-search-snippet': 'Community thread',
    'bluesky-search-snippet': 'Social post',
  }
  return labels[source] ?? 'Public mention'
}

function eventKindLabel(kind: string) {
  const labels: Record<string, string> = {
    outage: 'Outage',
    'metering-bug': 'Metering bug',
    latency: 'Latency',
    capacity: 'Capacity',
    'policy-change': 'Policy change',
    reset: 'Reset',
  }
  return labels[kind] ?? kind
}

function evidenceLabel(evidence: string) {
  const labels: Record<string, string> = {
    official: 'Official source',
    employee: 'Team post',
    community: 'Community report',
    inferred: 'Inferred signal',
  }
  return labels[evidence] ?? evidence
}

function attributionLabel(value: string) {
  const labels: Record<string, string> = {
    'Explicit/strong': 'Strong attribution',
    Likely: 'Likely attribution',
    Adjacent: 'Adjacent timing',
    Weak: 'Weak attribution',
    'No reset observed': 'No reset observed',
  }
  return labels[value] ?? value
}

function App() {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null)
  const [resetFeed, setResetFeed] = useState<ResetFeed | null>(null)
  const [socialSnapshot, setSocialSnapshot] = useState<SocialSnapshot | null>(null)
  const [reportStats, setReportStats] = useState<ReportStat[]>([])
  const [statsLoading, setStatsLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      loadJson<StatusSnapshot>('/data/status-snapshot.json'),
      loadJson<ResetFeed>('/data/resets.json'),
      loadJson<SocialSnapshot>('/data/social-snapshot.json'),
    ]).then(([statusSnapshot, resets, social]) => {
      setSnapshot(statusSnapshot)
      setResetFeed(resets)
      setSocialSnapshot(social)
    })
  }, [])

  const refreshStats = useCallback(() => {
    return fetchReportStats().then((stats) => {
      setReportStats((prev) => (stats.length === 0 && prev.length > 0 ? prev : stats))
      setStatsLoading(false)
    })
  }, [])

  useEffect(() => {
    refreshStats()
    const id = setInterval(refreshStats, STATS_POLL_MS)
    return () => clearInterval(id)
  }, [refreshStats])

  // Corroboration: an active official incident for a provider's company upgrades
  // its card from "user-reported only" to "corroborated".
  const corroboration = useMemo(() => {
    const map: Partial<Record<ProviderId, string>> = {}
    if (!snapshot) return map
    for (const provider of PROVIDERS) {
      const incident = snapshot.incidents.find(
        (i) => i.source === provider.company && !i.resolved_at && i.impact && i.impact !== 'none',
      )
      if (incident) map[provider.id] = incident.name
    }
    return map
  }, [snapshot])

  const liveEvents = useMemo(() => liveEventsFromSnapshot(snapshot, resetFeed), [snapshot, resetFeed])
  const events = useMemo(() => mergeEvents(seedEvents, liveEvents), [liveEvents])
  const stat = useMemo(() => metrics(events), [events])
  const predictions = useMemo(() => buildPredictions(events, socialSnapshot), [events, socialSnapshot])
  const recentLiveEvents = liveEvents.slice().sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp)).slice(0, 8)
  const topResetPrediction = predictions.slice().sort((a, b) => b.resetScore - a.resetScore)[0]
  const topPainPrediction = predictions.slice().sort((a, b) => b.painScore - a.painScore)[0]
  const latestIncident = recentLiveEvents[0]
  const highFitCount = recentLiveEvents.filter((event) => eventResetProbability(event) >= 58).length
  const socialHotCount = socialSnapshot?.topics.filter((topic) => topic.heat >= 58).length ?? 0

  // Pain score per reportable provider, mapped from its company's prediction.
  const painByProvider = useMemo(() => {
    const byCompany = new Map(predictions.map((p) => [p.company, p.painScore]))
    const map: Partial<Record<ProviderId, number>> = {}
    for (const provider of PROVIDERS) {
      const pain = byCompany.get(provider.company)
      if (pain != null) map[provider.id] = pain
    }
    return map
  }, [predictions])

  // Honest live condition for the secondary "is it down" module: blends
  // reports + pain + official incidents, and never reads "normal" just because
  // the report feed is empty.
  const liveCondition = useMemo<StatusTier>(() => {
    const byProvider = new Map(reportStats.map((s) => [s.provider, s]))
    let worst: StatusTier = 'normal'
    for (const provider of PROVIDERS.filter((p) => p.primary)) {
      const { tier } = blendCondition({
        stat: byProvider.get(provider.id),
        pain: painByProvider[provider.id],
        officialIncident: Boolean(corroboration[provider.id]),
      })
      if (tierIsWorse(tier, worst)) worst = tier
    }
    return worst
  }, [reportStats, painByProvider, corroboration])

  // Reset-led hero headline (the always-populated, valuable signal).
  const resetTone = topResetPrediction ? scoreTone(topResetPrediction.resetScore) : 'low'
  const heroHeadline = !topResetPrediction
    ? 'Watching for usage-reset signals.'
    : topResetPrediction.label === 'hot'
      ? `${topResetPrediction.companyLabel} is showing strong reset pressure.`
      : topResetPrediction.label === 'likely'
        ? `${topResetPrediction.companyLabel} may be heading for a usage reset.`
        : topResetPrediction.label === 'watch'
          ? `Watching ${topResetPrediction.companyLabel} for reset signals.`
          : 'No strong reset signal right now.'

  const liveConditionCopy =
    liveCondition === 'spike'
      ? 'A tool is struggling right now'
      : liveCondition === 'elevated'
        ? 'Elevated — worth a look'
        : 'All quiet right now'

  return (
    <>
      <a className="skip-link" href="#status">Skip to live status</a>
      <header className="site-header" aria-label="AI Down Detector navigation">
        <a className="brand" href="#top" aria-label="AI Down Detector home">
          <span className="brand-mark" aria-hidden="true">◐</span>
          <span>AI Down Detector</span>
        </a>
        <nav>
          <a href="#status">Live status</a>
          <a href="#predictions">Forecast</a>
          <a href="#community-heat">Community</a>
          <a href="#live-incidents">Incidents</a>
          <a href="#method">Method</a>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <div className="eyebrow"><span /> Usage-reset + pain forecast for AI coding tools</div>
          <div className="hero-grid">
            <div>
              <h1 className="hero-title"><span className={`hero-dot tone-${resetTone}`} aria-hidden="true" />{heroHeadline}</h1>
              <p className="lede">
                AI Down Detector forecasts whether AI coding tools are likely to issue a make-good usage reset —
                and how much pain developers are feeling — from official status and public chatter.
              </p>
              <div className="hero-actions">
                <a href="#predictions">See the forecast</a>
                <a className="ghost" href="#status">Is a tool down now?</a>
              </div>
            </div>
            <aside className="signal-card dual" aria-label="Reset and pain summary">
              <p className="card-label">Current read · reset vs pain</p>
              <div className="readout-grid">
                <div>
                  <span>Reset odds</span>
                  <strong>{topResetPrediction?.resetScore ?? '—'}<small>/100</small></strong>
                  <em>{topResetPrediction ? `${topResetPrediction.companyLabel}: ${confidenceCopy(topResetPrediction.label)}.` : 'Waiting for status data.'}</em>
                </div>
                <div>
                  <span>Pain index</span>
                  <strong>{topPainPrediction?.painScore ?? '—'}<small>/100</small></strong>
                  <em>{topPainPrediction ? `${topPainPrediction.companyLabel}: ${painCopy(topPainPrediction.painLabel)}.` : 'Waiting for community data.'}</em>
                </div>
              </div>
              <div className="mini-stats">
                <div><b>{stat.usageMakeGoodRate}%</b><small>usage reset rate</small></div>
                <div><b>{resetFeed?.resets.length ?? '—'}</b><small>known resets</small></div>
                <div><b>{socialHotCount}</b><small>hot topics</small></div>
              </div>
              <p className="freshness">Status: {fmtDate(snapshot?.generated_at)} · Community: {fmtDate(socialSnapshot?.generated_at)}</p>
            </aside>
          </div>

          <div className="briefing-strip" aria-label="AI Down Detector briefing">
            <article>
              <span>Latest match</span>
              <b>{latestIncident ? latestIncident.companyLabel : 'No live match yet'}</b>
              <p>{latestIncident ? latestIncident.title : 'The forecast is using curated historical evidence until the live feed updates.'}</p>
            </article>
            <article>
              <span>Reset-relevant matches</span>
              <b>{snapshot ? highFitCount : '—'}</b>
              <p>Current incidents with strong usage, quota, metering, or root-cause language.</p>
            </article>
            <article>
              <span>Signal health</span>
              <b>{(snapshot?.errors.length || socialSnapshot?.errors.length) ? 'Degraded' : snapshot && socialSnapshot ? 'Clean' : 'Loading'}</b>
              <p>Official status pages and public community chatter are refreshing normally.</p>
            </article>
          </div>
        </section>

        <section id="status" className="section">
          <div className="section-heading">
            <p className="card-label">Live status</p>
            <h2>Is a tool down right now?</h2>
            <p>
              <span className={`status-pill tier-${liveCondition}`}>{liveConditionCopy}</span>
              Crowdsourced reports, cross-checked against official status and community pain. It stays quiet
              until developers start reporting or an official incident lands — so report it if you see it.
            </p>
          </div>
          <div className="hero-status">
            <IncidentCards
              stats={reportStats}
              painByProvider={painByProvider}
              corroboration={corroboration}
              loading={statsLoading}
            />
            <ReportWidget onSubmitted={refreshStats} />
          </div>
        </section>

        <section id="predictions" className="section">
          <div className="section-heading">
            <p className="card-label">Forecast</p>
            <h2>Reset odds vs pain index</h2>
            <p>Generic outages can make the pain index spike while reset odds stay low. Quota, metering, over-drain, and root-cause language still matter most for usage resets.</p>
          </div>
          <div className="prediction-grid">
            {predictions.map((prediction) => (
              <article className={`prediction ${prediction.label}`} key={prediction.company}>
                <div className="prediction-top">
                  <div>
                    <p className="card-label">{prediction.companyLabel}</p>
                    <h3>{prediction.label}</h3>
                    <span>{confidenceCopy(prediction.label)}</span>
                  </div>
                  <div className="score-pair">
                    <div className="score-ring" style={{ '--score': `${prediction.resetScore}%` } as React.CSSProperties}>
                      <b>{prediction.resetScore}</b>
                      <span>reset</span>
                    </div>
                    <div className="score-ring pain" style={{ '--score': `${prediction.painScore}%` } as React.CSSProperties}>
                      <b>{prediction.painScore}</b>
                      <span>pain</span>
                    </div>
                  </div>
                </div>
                <p className="window">{prediction.nextWindow}</p>
                <div className="score-explainer">
                  <span className={`pill ${scoreTone(prediction.resetScore)}`}>reset odds {prediction.resetScore}/100</span>
                  <span className={`pill ${scoreTone(prediction.painScore)}`}>pain index {prediction.painScore}/100</span>
                  <span className="pill low">{prediction.painLabel}</span>
                </div>
                <div className="drivers">
                  <b>Reset drivers</b>
                  <ul>{prediction.drivers.map((driver) => <li key={driver}>{driver}</li>)}</ul>
                </div>
                <div className="drivers pain-drivers">
                  <b>Pain drivers</b>
                  <ul>{prediction.painDrivers.map((driver) => <li key={driver}>{driver}</li>)}</ul>
                </div>
                <div className="blockers">
                  <b>Why this can be wrong</b>
                  <ul>{prediction.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section id="community-heat" className="section">
          <div className="section-heading">
            <p className="card-label">Community heat</p>
            <h2>Community heat</h2>
            <p>A lightweight read on whether developers are broadly reporting slowdowns, errors, limit drain, or degraded coding sessions.</p>
          </div>
          <div className="social-grid">
            {socialSnapshot?.topics.length ? socialSnapshot.topics.map((topic) => (
              <article className="social-card" key={topic.id}>
                <div className="social-top">
                  <div>
                    <p className="card-label">{topic.product}</p>
                    <h3>{topic.heat}/100 heat</h3>
                    <span>{communityBasis(topic.volume, topic.heat)}</span>
                  </div>
                  <span className={`pill ${scoreTone(topic.heat)}`}>{topic.pain_chatter}/100 pain</span>
                </div>
                <div className="tags">
                  {topic.top_terms.slice(0, 8).map((term) => <span key={term}>{term}</span>)}
                </div>
                <p className="source-line">Basis: {topic.heat >= 58 ? sourceSummary(topic.sources) : 'No active public cluster'}</p>
                <div className="examples">
                  {topic.examples.slice(0, 4).map((example) => (
                    <a href={example.url} target="_blank" rel="noreferrer" key={`${example.source}-${example.title}`}>
                      <small>{exampleSourceLabel(example.source)}</small>
                      <span>{example.title}</span>
                    </a>
                  ))}
                </div>
              </article>
            )) : (
              <article className="empty-state">
                <h3>No community read yet</h3>
                <p>Community signals are quiet or still refreshing. Check back shortly if chatter is moving fast.</p>
              </article>
            )}
          </div>
          <p className="report-cta-line">
            Seeing it yourself? <a href="#status">Report it at the top</a> — your one-tap reports drive the live status above.
          </p>
        </section>

        <section id="live-incidents" className="section">
          <div className="section-heading">
            <p className="card-label">Live incidents</p>
            <h2>Official incident matches</h2>
            <p>Official incidents refresh regularly and feed into the forecast. Public chatter is shown separately above.</p>
          </div>
          <div className="live-meta">
            <span>Official update: {snapshot ? fmtDate(snapshot.generated_at) : 'refreshing'}</span>
            <span>Community update: {socialSnapshot ? fmtDate(socialSnapshot.generated_at) : 'refreshing'}</span>
            <span>Official feed issues: {snapshot?.errors.length ?? 0}</span>
            <span>Community feed issues: {socialSnapshot?.errors.length ?? 0}</span>
          </div>
          <div className="timeline compact">
            {recentLiveEvents.length ? recentLiveEvents.map((event) => {
              const probability = eventResetProbability(event)
              const pain = eventPainScore(event)
              return (
                <article className="event" key={event.id}>
                  <div className="event-date">{fmtDate(event.timestamp)}</div>
                  <div className="event-body">
                    <div className="event-title-row">
                      <h3>{event.title}</h3>
                      <div className="event-pills">
                        <span className={`pill ${scoreTone(probability)}`}>{probability}% reset signal</span>
                        <span className={`pill ${scoreTone(pain)}`}>{pain}% pain</span>
                      </div>
                    </div>
                    <p>{event.userImpact}</p>
                    <div className="tags">
                      <span>{event.companyLabel}</span>
                      <span>{event.product}</span>
                      <span>{eventKindLabel(event.kind)}</span>
                      <span>{event.resetIssued ? 'Reset matched' : 'No reset matched yet'}</span>
                    </div>
                  </div>
                </article>
              )
            }) : (
              <article className="empty-state">
                <h3>No current incident matches</h3>
                <p>Official incident feeds have not surfaced a strong reset-relevant match yet.</p>
              </article>
            )}
          </div>
        </section>

        <section id="method" className="section split">
          <div>
            <p className="card-label">Method</p>
            <h2>What AI Down Detector looks for</h2>
            <p className="muted">The strongest reset trigger is a root-caused bug that depleted paid limits incorrectly. General errors are weak reset signals but strong pain signals.</p>
          </div>
          <ol className="signal-list">
            {watchlistSignals.map((signal) => <li key={signal}>{signal}</li>)}
            <li>Community heat looks for public clusters around degraded, slow, unusable, limit-drain, and reset language.</li>
            <li>Reset odds and pain index are intentionally separate so “Codex feels cooked” does not automatically imply “reset incoming.”</li>
          </ol>
        </section>

        <section id="evidence" className="section">
          <div className="section-heading">
            <p className="card-label">Past evidence</p>
            <h2>Known reset examples</h2>
            <p>Past examples provide the baseline; current incidents and community heat update the read above.</p>
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
                      <span className={`pill ${scoreTone(probability)}`}>{probability}% reset signal</span>
                    </div>
                    <p>{event.userImpact}</p>
                    <div className="tags">
                      <span>{event.companyLabel}</span>
                      <span>{event.product}</span>
                      <span>{eventKindLabel(event.kind)}</span>
                      <span>{evidenceLabel(event.evidence)}</span>
                      <span>{attributionLabel(attribution(event))}</span>
                      {event.resetIssued && <span>reset lag: {lagHours(event) ?? 'unknown'}h</span>}
                    </div>
                    <p className="notes">{event.notes}</p>
                    {event.sourceUrl && <a className="source" href={event.sourceUrl} target="_blank" rel="noreferrer">Source: {event.sourceLabel}</a>}
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        <section id="failure-points" className="section">
          <div className="section-heading">
            <p className="card-label">Caveats</p>
            <h2>Where the forecast can be wrong</h2>
            <p>These caveats explain when the score can miss, overreact, or confuse pain with reset likelihood.</p>
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
              <p>Public signal clarity: {company.publicSignalQuality}/100</p>
              <p>Useful places to check: {company.resetChannels.join(', ')}</p>
              <a href={company.statusUrl} target="_blank" rel="noreferrer">{company.statusUrl}</a>
            </article>
          ))}
        </section>
      </main>

      <footer className="site-footer">
        <span>AI Down Detector is an unofficial, community-powered status tracker for AI coding tools. Reports are crowdsourced and unverified.</span>
        <a href="https://status.claude.com" target="_blank" rel="noreferrer">Anthropic status</a>
        <a href="https://status.openai.com" target="_blank" rel="noreferrer">OpenAI status</a>
        <a href="#status">Report a problem</a>
      </footer>
    </>
  )
}

export default App
