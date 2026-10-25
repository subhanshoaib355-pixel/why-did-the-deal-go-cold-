# Use Case 18: Customer Experience Intelligence

This folder is the G42 Agentathon submission for use case 18. Five agents share one H-MEM store and one typed context. They explain why a CRM deal went cold, tag sentiment, map the journey, rank pain, and recommend a next step.

Sample mode reads `data/*.json`. It does not log in to Zetaris.

## Setup

```bash
npm install
cp .env.example .env
```

Leave `SAMPLE_MODE=true` in `.env` for the sample path. Fill Zetaris names only when you intend a live SQL run. Do not commit `.env`.

`vendor/hmem` is the H-MEM reference. `src/engine.ts` loads it first. No embedding API and no API key are required.

## Run sample mode

From this folder:

```bash
SAMPLE_MODE=true npx tsx hmem.ts D004
```

`npx tsx hmem.ts` defaults to D004. Pass `D001` through `D008`, or `all` for the pain ranking.

On PowerShell:

```powershell
$env:SAMPLE_MODE = "true"
npx tsx hmem.ts D004
```

D004 is HIGH from email E009. D008 is HIGH from call note N008. D005 is LOW after three weak attempts.

The API listens on port 8000:

```bash
python run.py
```

By default it binds only to `127.0.0.1`. Set `HOST` and `PORT` explicitly if the service is intentionally deployed elsewhere; deployments outside localhost should add authentication and rate limiting.

`GET /health` returns status. `GET /run?deal_id=D004` and `POST /run` with `{"deal_id":"D004"}` or `{"deal_id":"all"}` force `SAMPLE_MODE=true`. POST also accepts `"refresh": true` to bypass the server cache and run the agents again. Chat questions and **Run Agent Now** use refresh so a subsequent run can recall newly written H-MEM context; **Sync CRM** can use the current cached result. Responses include the current `worldModel` state and any `priorColdContext` recalled for that deal. `crm` copies the deal and primary contact fields the agent loaded: company, contact name, email, role, stage, status, last activity date, and deal value. `hmem.ts --json` prints that object and nothing else.

When the run marks a lead cold or frozen, it writes the reason and first suggested action to H-MEM as a `cold-detection` event and writes the current CRM status, stage, temperature, and activity date as a `world-state` event. A later run retrieves the latest cold-detection event before aggregation and recommendation, then exposes the recalled context on the verdict and first recommendation. These durable state events are excluded from sleep synthesis.

Run the isolated provider, orchestration, and memory tests with `npx tsx --test tests/world-model.test.ts tests/sentiment-agent.test.ts tests/orchestrator-xai.test.ts`. Run API cache and `.env` loader tests with `python -m unittest discover -s tests -p "test_*.py"`.

Refresh the sample files from live Zetaris with `npx tsx scripts/export-data.ts`. That path needs Zetaris credentials and is not part of sample mode.

## Agents

| Agent | Role |
|---|---|
| Feedback Aggregator | Recall, plan, query, and judge evidence. Up to 3 attempts. |
| Sentiment Agent | Classify each deal's feedback as positive, neutral, or negative using configured Grok or the local `keyword` fallback. |
| Journey Mapper | Map CRM status and stage to a journey stage. Terminal status wins. |
| Pain Detector | Extract pain tags and rank them. Ask the aggregator to widen when a deal has no tags. |
| Recommender | Keep the evidence reason and add recovery steps tied to evidence ids. |

The orchestrator in `agents/orchestrator.ts` runs that order for one deal. `hmem.ts` is the command line entry. The backend loads `.env` before running and preserves environment variables already supplied by the host.

Sentiment uses the local keyword model unless Grok is configured. To use Grok, add `XAI_API_KEY` to the ignored `.env` file. With `SENTIMENT_PROVIDER=auto` (the default), Grok is selected when the key is present and keyword sentiment is used if Grok is unavailable; the response reports when fallback occurred. Set `SENTIMENT_PROVIDER=keyword` to disable Grok, or `SENTIMENT_PROVIDER=xai` to require Grok and fail clearly on provider errors. `GROK_MODEL` defaults to `grok-4.7`. Feedback text is sent to xAI when Grok is selected; the API key remains on the backend and is never sent to the browser. No NVIDIA provider was present in this agent, so Grok replaces the previous keyword-only sentiment role rather than an existing NVIDIA integration.

## Logs

Each run writes `logs/<runId>.jsonl` and `logs/<runId>.md`. Those generated files are gitignored and are not included in the public package.

## License

Apache 2.0.
