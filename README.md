# Reset Watch

A Vercel-ready tracker for Claude Code and Codex incidents that may trigger usage/rate-limit "make-good" resets.

The app is intentionally evidence-first:

- separates incidents from reset announcements
- scores reset likelihood from public signals
- labels attribution as explicit, likely, adjacent, weak, or none
- documents failure points so the forecast does not become wishcasting

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Deployment

This is a normal Vite React static app and can be deployed directly to Vercel.

Suggested Vercel settings:

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`

## Data model

Seed data lives in `src/data.ts`. Scoring logic lives in `src/model.ts`.

Future ingestion ideas:

1. Pull `https://status.claude.com/api/v2/incidents.json` and `https://status.openai.com/api/v2/incidents.json` on a schedule.
2. Track public reset announcements from official/team social accounts.
3. Match reset events to incidents with 24h, 72h, and 7d windows.
4. Save source snapshots because posts/status text can change.
5. Keep manual/community reports lower confidence until corroborated.

## Known limitations

- Public status APIs often do not mention usage resets.
- Social announcements may be celebratory rather than explicit apologies.
- Account-specific credits are invisible unless users report them.
- Prediction is a business-policy estimate, not a guarantee.
