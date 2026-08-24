# Email-triggered scraping — setup

Turns a NextEra requisition email into a Fieldglass scrape of that one posting,
within about a minute, with no laptop or server involved.

```
Gmail ──(Apps Script, every 1 min, free)──> POST /repos/:owner/:repo/dispatches
                                            {event_type: "new-requisition",
                                             client_payload: {job_id: "NEEJP00020528"}}
                                                     │
                                                     v
   .github/workflows/requisition-trigger.yml  (on: repository_dispatch)
       └─> npm run watch:email -- --job=NEEJP00020528
             └─> targeted Playwright scrape ─> PII masking ─> DB upsert
```

**Why Apps Script and not a scheduled workflow.** GitHub Actions cannot listen
for email — it can only poll or be pushed to. Polling Gmail every 5 minutes from
a workflow costs ~8,600 runner minutes/month (~$50+) because it runs whether or
not mail arrived. Here Google does the polling for free and GitHub only wakes up
for real requisitions: roughly 900 minutes/month, inside the free tier.

Files: [requisition-trigger.yml](../.github/workflows/requisition-trigger.yml) ·
[requisition-dispatch.gs](../scripts/apps-script/requisition-dispatch.gs)

---

## 1. Get the workflow onto `main`

`repository_dispatch` **only ever runs the workflow as it exists on the default
branch.** A dispatch against a feature branch does nothing at all — no run, no
error. Merge `.github/workflows/requisition-trigger.yml` to `main` first, or
everything below will look correctly configured while silently doing nothing.

Confirm the repo secrets from `scrape.yml` are present (Settings → Secrets and
variables → Actions): `FIELDGLASS_URL`, `FIELDGLASS_USERNAME`,
`FIELDGLASS_PASSWORD`, `DATABASE_URL`. This workflow reuses them and adds none.

## 2. Create a fine-grained GitHub token

github.com → Settings → Developer settings → **Personal access tokens →
Fine-grained tokens** → Generate new token.

| Field | Value |
| --- | --- |
| Resource owner | `richards-lgtm` |
| Repository access | Only select repositories → `recruitment-ai-platform` |
| Repository permissions | **Contents: Read and write** (this is what `dispatches` requires) |
| Expiration | your call — note the date, dispatches fail silently-ish (401) after it |

Nothing else needs enabling. Copy the token once; GitHub won't show it again.

## 3. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) **signed in as the
   mailbox that receives the requisition emails**, and create a new project.
   Name it something like `Fieldglass requisition dispatch`.
2. Replace the contents of `Code.gs` with
   [scripts/apps-script/requisition-dispatch.gs](../scripts/apps-script/requisition-dispatch.gs).
3. Check the config block at the top — `GITHUB_OWNER`, `GITHUB_REPO`, and
   especially `SEARCH_QUERY`, whose `from:` and `subject:` must match the real
   notification mail. They mirror `GMAIL_REQUISITION_FROM` /
   `GMAIL_REQUISITION_SUBJECT` in `.env`.
4. **Project Settings → Script Properties → Add script property**:
   `GITHUB_TOKEN` = the token from step 2. Keep it out of the code itself.

## 4. Install the trigger

In the editor, select the `setup` function and **Run**. Google will ask you to
authorize Gmail access and external requests — that consent is what lets the
script read the mailbox and call GitHub.

`setup()` creates the `fieldglass-dispatched` /`fieldglass-dispatch-failed`
labels and installs a 1-minute time-driven trigger. Re-running it replaces the
trigger rather than stacking duplicates.

## 5. Verify, in order

| Step | How | Expect |
| --- | --- | --- |
| Gmail search matches | Run `dryRun()` | Logs recent requisition threads and the ids parsed from them |
| GitHub accepts dispatches | Run `testDispatch()` | `Dispatch accepted (204)` and a new run in the Actions tab |
| Scrape works end to end | Watch that run | `✓ NEEJP… scraped and upserted` |
| Real mail fires it | Wait for the next requisition | Thread gains the `fieldglass-dispatched` label; a run appears within ~1 min |

You can also trigger a run by hand from Actions → *Requisition email trigger* →
Run workflow, entering a job id — useful for testing the GitHub half before the
Gmail half exists.

## How it stays idempotent

The `fieldglass-dispatched` Gmail label **is** the state. There's no watermark
file and nothing to persist on the GitHub side, which is what makes this work on
ephemeral runners. The label is applied only after GitHub returns 204, so a
failed dispatch is simply retried on the next tick.

Two further layers of protection: the scrape is an upsert keyed on `job_id`, so
a duplicate trigger just refreshes the row; and `--job=` validates the id shape
before it reaches Playwright.

## Known limits

- **The email usually beats the portal.** Fieldglass frequently publishes the
  posting a few minutes after notifying. The workflow tries once, waits 3
  minutes, tries again, then emits a warning and leaves it to the 30-minute
  scheduled scrape. That's a routine race, not a failure — hence a warning
  rather than a red build.
- **Bursts can drop dispatches.** The workflow shares `scrape.yml`'s
  concurrency group so two Fieldglass sessions never run at once, and GitHub
  keeps only one run queued per group. Several requisitions landing together
  means some wait for the scheduled scrape instead.
- **Apps Script quotas** are generous but real: `UrlFetchApp` is capped around
  20k calls/day on a consumer account, and Google may skip trigger ticks under
  load. Neither binds at this volume.
- **Governance.** No Gmail credentials reach GitHub — the mailbox is only
  touched by Apps Script under the mailbox owner's own account, and the only
  thing crossing the boundary is a job id. Everything else (Fieldglass creds,
  `DATABASE_URL`, cloud execution) is the same dev-only exception class as
  `scrape.yml`, still pending manager sign-off.

## If it stops working

| Symptom | Likely cause |
| --- | --- |
| `dryRun()` finds nothing | `SEARCH_QUERY` doesn't match the real sender/subject, or the thread is already labelled — drop `-label:fieldglass-dispatched` to check |
| Dispatch logs `404` | Token lacks Contents: write, wrong owner/repo, or token expired |
| `204` but no Actions run | Workflow file isn't on the **default branch** (see step 1), or `event_type` ≠ the workflow's `types` |
| Run fails on `Validate job id` | Something parsed a non-id from the subject; check the `Requisition ID:` format against `JOB_ID_RE` |
| Runs but scrapes nothing | Posting genuinely isn't in the work-items list yet — check for the `::warning::` and let the scheduled scrape handle it |

## The alternative worth remembering

The existing local watcher (`npm run watch:email`) uses IMAP IDLE, giving
**sub-second** latency with no polling, no runner minutes, and mail credentials
that never leave the network. Running it as a systemd service on VDHY045 is the
better production answer; this Actions path is the cloud/dev convenience path,
matching the same split already described for `scrape.yml`.
