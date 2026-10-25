# NeverGoCold — Submission Package

NeverGoCold analyzes sample CRM deals, identifies evidence that a deal may be going cold, and suggests practical recovery steps. The dashboard uses a local Python API that runs the TypeScript agent orchestrator and its H-MEM memory engine.

## Package contents

- `frontend/` — browser dashboard and chat panel.
- `backend/` — Python API, TypeScript agents, bundled H-MEM engine, sample CRM data, and tests.

The bundle intentionally excludes local secrets, saved H-MEM data, dependency folders, and generated run logs. The backend sample data is included.

All CRM fixtures in `backend/data/` use synthetic identities and `example.com` email addresses. Captured local run traces are excluded.

## Requirements

- Node.js 22 or later
- Python 3.10 or later
- Internet access to load the dashboard's Chart.js and Lucide assets from their CDNs

## Run locally on Windows

### 1. Install and start the backend

Open PowerShell in this package folder:

```powershell
Set-Location .\backend
npm ci
Copy-Item .env.example .env
python run.py
```

Keep this terminal open. The API listens on `http://127.0.0.1:8000`.

Sample mode is enabled by default. No model key is needed to run the local keyword sentiment classifier. Grok is optional: add your own valid `XAI_API_KEY` to `backend/.env`. With `SENTIMENT_PROVIDER=auto`, the backend uses Grok when a key is configured and reports when it has to fall back to local keyword sentiment. Never include `.env` or API keys in a submission.

### 2. Serve the dashboard

Open a second PowerShell window in the package folder:

```powershell
Set-Location .\frontend
python -m http.server 5500
```

Open <http://localhost:5500>. The frontend is configured to call the local backend at `http://localhost:8000`.

## Run the agent directly

From `backend/`:

```powershell
npx tsx hmem.ts D003
npx tsx hmem.ts all
```

The API also exposes `GET /health` and `GET /run?deal_id=D003`. The dashboard uses `POST /run`.

## Tests

From `backend/`:

```powershell
npx tsx --test tests/world-model.test.ts tests/sentiment-agent.test.ts tests/orchestrator-xai.test.ts
python -m unittest discover -s tests -p "test_*.py"
```

The Grok tests use mocked provider responses; they do not require an xAI key or make live provider calls.

## Notes

- Sample mode reads the JSON files in `backend/data/`; it does not connect to Zetaris.
- H-MEM persists local run data under `backend/.deal-memory/`. That folder is local runtime state and is excluded from this package.
- When Grok is selected, feedback text is sent to xAI for sentiment classification. The API key remains on the backend and must not be exposed in the browser.
- The dashboard is a demo interface. Its approval/send controls do not send real emails.
