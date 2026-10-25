# hackathon-agrnt-frontend

AI Sales Agent frontend for **NeverGoCold** — built for the hackathon.

## Quick Start

Start the agent API, then serve this folder:

```bash
python -m http.server 5500
```

Open `http://localhost:5500`. The page loads deals from `http://localhost:8000`. Change that base URL in `config.js`.

Pipeline refreshes and chat questions both go through the backend's `POST /run` API. Chat requests send a matching deal ID, or `all` for pipeline-wide questions, and set `refresh: true` so the backend reruns the agents and can recall new H-MEM context. **Run Agent Now** also refreshes; **Sync CRM** can use the server cache. The browser does not connect to an agent runtime or hold model credentials.

There is no compile step. `index.html` is the app.

## Stack
- Vanilla HTML + CSS + JavaScript
- Chart.js (doughnut chart)
- Lucide Icons

## Pages
1. **Dashboard** — KPIs, activity feed, temperature chart
2. **Leads Pipeline** — searchable table with filter pills
3. **Lead Detail Panel** — AI reasoning, editable follow-up, timeline
4. **Activity Log** — full agent action history
5. **Settings** — toggles, thresholds, tone selector, integrations
