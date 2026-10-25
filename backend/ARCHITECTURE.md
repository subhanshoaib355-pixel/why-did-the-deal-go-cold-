# Architecture

Use case 18 runs one orchestrator and five agents. They share `SharedContext` and write events into H-MEM under `.deal-memory/`.

```
Orchestrator
  -> Feedback Aggregator
  -> Sentiment Agent
  -> Journey Mapper
  -> Pain Detector
  -> Recommender
  -> World Model
```

If the Pain Detector finds no tags, it asks the Feedback Aggregator to widen. A widen that runs sends the new feedback through sentiment, journey, and pain again. The Recommender runs last. Sleep then remaps memory ids. The verdict is written after that remap.

The Feedback Aggregator retrieves the latest `cold-detection` event for the deal before gathering evidence. The Recommender receives that context and attaches its reason, previous suggested action, and timestamp to the next recommendation. After recommendations are ready, the World Model persists the current CRM status, stage, activity date, temperature, reason, and suggested action. Cold or frozen leads also get a `cold-detection` event in H-MEM. Both event types are excluded from sleep synthesis so the latest state remains directly retrievable.

## Feedback Aggregator

`aggregate()` plans a Zetaris read, or a sample JSON read when `SAMPLE_MODE=true`. Sample mode returns before any login.

Evidence is STRONG when the deal has an email or a call note, the latest item is within 30 days of `last_activity_date`, and a lost, won, or stalled status is explained by that text. Open deals do not need an explanation. Anything else is WEAK.

Attempt 1 reads the deal, the contact by `contact_id`, emails for the deal, and call notes for the deal. Attempt 2 reads every email for the deal plus emails whose from or to matches the contact email. Attempt 3 reads other contacts at the same company and their emails. Call notes are matched by company name only when that column exists. This export has no company column on call notes.

Confidence is HIGH when attempt 1 is strong, MEDIUM when attempt 2 or 3 is the first strong pass, and LOW when all three stays weak. The LOW reason lists the missing evidence. Reason text copies database values. It is not paraphrased.

A widen on an already STRONG deal runs the next query, then restores reason, confidence, attempts, plan, audit, recalled ids, and evidence ids.

## Sentiment provider

The Sentiment Agent batches a deal's feedback into one request. `SENTIMENT_PROVIDER=auto` selects xAI Grok when `XAI_API_KEY` is present and otherwise uses the local keyword model. If Grok is unavailable in `auto` mode, the agent reports the provider error and completes sentiment analysis with the local keyword model; the response identifies that fallback. Set `SENTIMENT_PROVIDER=keyword` to force local classification or `xai` to require Grok and fail on provider errors. The key stays in the backend environment. Feedback text is sent to xAI only when Grok is selected; record content is treated as untrusted data in the classification prompt.

## Recall

Writes for sentiment, journey, pain, recommendation, and verdict events store structured tags: `deal_id`, company, contact name, contact email, status, journey stage, pain tags, and confidence. Pain tags are budget, competitor, timing, integration, no-response, and legal.

`recallScored()` does not call the embedding query. It loads stored memories, derives tags for older rows, and skips a row that has no `D###` deal id. Sleep synthesis rows are skipped.

Score weights:

| Match | Weight | Reason text |
|---|---|---|
| Exact deal id | 1000 | same deal |
| Same company | 100 | same company |
| Same contact name or email | 40 | same contact |
| Each shared pain tag | 20 | shared tag budget |
| Same status | 10 | same status lost |

The top 5 hits with score above 0 are returned. Each hit is a compact summary of at most 180 characters. The Feedback Aggregator records those hits on the deal. The Pain Detector recalls again with the current deal excluded and keeps hits that share a pain tag. The Recommender may append one line such as `Similar past deal D006 shares budget`. That line is context. It does not replace `rootCause`.

`cold-detection` recall is exact by deal id and event type rather than semantic ranking, so the latest reason and suggested action are available before a follow-up is generated.

## API refresh

`POST /run` accepts `{"deal_id":"D004","refresh":true}` to bypass the in-process response cache. Without refresh, repeated requests can return the cached verdict and do not rerun H-MEM. The frontend uses refresh for chat questions and **Run Agent Now**, while **Sync CRM** may reuse the cached result.

## Trace logs

`agents/trace.ts` records each handoff. Fields are timestamp, run id, deal id, from, to, kind, summary, CRM evidence ids, and duration. Kinds are `handoff`, `widen request`, `widen refused`, `result`, and `recall`. Recall lines name the memory id, the deal id, and the match reasons. Secrets, bearer tokens, and JWTs are scrubbed before write.

`hmem.ts` prints the JSON verdict, then the timeline. Generated traces are local-only and are not included in the public package.
