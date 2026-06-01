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

- Seed examples live in `src/data.ts`.
- Scoring logic lives in `src/model.ts`.
- Runtime status ingestion lives in `src/live.ts`.
- Public status snapshots live at `public/data/status-snapshot.json`.
- Curated reset announcements live at `public/data/resets.json`.

## Auto-update flow

The repo includes `.github/workflows/refresh-status.yml`, which runs hourly via GitHub Actions cron:

1. Fetch `https://status.claude.com/api/v2/incidents.json` and `https://status.openai.com/api/v2/incidents.json`.
2. Filter incidents for coding/usage keywords.
3. Write `public/data/status-snapshot.json`.
4. Run `npm run build`.
5. Commit the snapshot if it changed.

When the GitHub repo is connected to Vercel, that commit triggers a Vercel redeploy. The deployed app then reads `/data/status-snapshot.json` and `/data/resets.json` at runtime.

Manual refresh:

```bash
npm run fetch:status
```

Useful next additions:

1. Add more reset announcements to `public/data/resets.json`.
2. Archive source screenshots/links for reset posts that may disappear.
3. Add optional Discord/Telegram alerts when a new high-fit incident appears.
4. Add a small public report form for “my quota drained unusually fast” / “my quota reset.”

## Known limitations

- Public status APIs often do not mention usage resets.
- Social announcements may be celebratory rather than explicit apologies.
- Account-specific credits are invisible unless users report them.
- Prediction is a business-policy estimate, not a guarantee.
