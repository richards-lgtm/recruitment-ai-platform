/**
 * Gmail -> GitHub Actions bridge for the Fieldglass scraper.
 *
 * Runs on Google Apps Script (script.google.com), NOT in this repo's runtime —
 * it is kept here so the trigger side is version-controlled alongside the
 * workflow it fires. Paste it into a standalone Apps Script project owned by
 * the mailbox that receives NextEra requisition notifications.
 *
 * What it does, once a minute:
 *   search Gmail for unprocessed requisition mail
 *   -> pull the Requisition ID out of the subject (body as fallback)
 *   -> POST /repos/:owner/:repo/dispatches  {event_type: "new-requisition"}
 *   -> label the thread so it never fires twice
 *
 * Why Apps Script rather than polling from a scheduled workflow: Google runs the
 * poll for free, so GitHub runner minutes are only spent when a requisition
 * actually arrives (~900 min/month instead of ~8,600).
 *
 * Setup: docs/email-trigger-setup.md. Nothing secret is stored in this file —
 * the GitHub token lives in Script Properties.
 */

// --- Configuration ----------------------------------------------------------
// Repo that owns .github/workflows/requisition-trigger.yml.
var GITHUB_OWNER = 'richards-lgtm';
var GITHUB_REPO = 'recruitment-ai-platform';

// Must match the workflow's `repository_dispatch.types`.
var EVENT_TYPE = 'new-requisition';

// Gmail search for mail not yet dispatched. newer_than bounds the scan so this
// can never walk the whole mailbox; the label is the real deduplication.
var SEARCH_QUERY =
  'subject:("new requisition" "submitted") ' +
  'from:nextera@vdartinc.com ' +
  'newer_than:2d ' +
  '-label:fieldglass-dispatched';

// Applied after a successful dispatch. Doubles as the "already handled" marker,
// which is why no state file or watermark is needed on either side.
var DONE_LABEL = 'fieldglass-dispatched';
// Applied when a matching email carries no parsable id — surfaces the problem
// in the mailbox instead of silently dropping it.
var FAILED_LABEL = 'fieldglass-dispatch-failed';

// Safety rail: a mail-storm shouldn't fire hundreds of Actions runs.
var MAX_THREADS_PER_RUN = 10;

// Capture group 1 is the Fieldglass job id. Mirrors GMAIL_JOB_ID_PATTERN in
// scripts/watch-requisition-email.ts — keep the two in step.
var JOB_ID_RE = /Requisition ID:\s*([A-Za-z0-9_-]+)/i;

// --- Main entry point (this is what the time-driven trigger calls) ----------

function checkForRequisitions() {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set. Project Settings -> Script Properties -> add ' +
        'GITHUB_TOKEN = a fine-grained PAT with Contents: Read and write on ' +
        GITHUB_OWNER + '/' + GITHUB_REPO
    );
  }

  var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS_PER_RUN);
  if (threads.length === 0) return;

  var doneLabel = getOrCreateLabel(DONE_LABEL);
  var failedLabel = getOrCreateLabel(FAILED_LABEL);

  // ONE dispatch for the whole tick, not one per email. Requisitions do arrive
  // in clusters, and the workflow shares a concurrency group with the scheduled
  // scrape — GitHub keeps only one run queued per group, so N simultaneous
  // dispatches would see most of them CANCELLED, and those postings would fall
  // back to the 30-minute scrape. Exactly the delay this trigger exists to
  // avoid, on the busiest mornings. The scrape spec accepts a comma-separated
  // FIELDGLASS_JOB_IDS and handles them in one browser session.
  var jobIds = [];      // unique ids, dispatch payload
  var matched = [];     // threads to label once GitHub accepts

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();
    var jobId = null;

    // Newest message first: a re-sent notification should win over the original.
    for (var m = messages.length - 1; m >= 0 && !jobId; m--) {
      jobId = extractJobId(messages[m].getSubject()) ||
              extractJobId(messages[m].getPlainBody());
    }

    if (!jobId) {
      Logger.log('No requisition id found in: ' + thread.getFirstMessageSubject());
      thread.addLabel(failedLabel);
      continue;
    }

    // Two emails can reference the same requisition (re-sends, replies): label
    // both threads, but send the id once.
    if (jobIds.indexOf(jobId) === -1) jobIds.push(jobId);
    matched.push(thread);
  }

  if (jobIds.length === 0) return;

  if (dispatch(token, jobIds.join(','))) {
    // Label ONLY after GitHub accepted it, so a failed dispatch is retried on
    // the next tick rather than lost.
    for (var t = 0; t < matched.length; t++) matched[t].addLabel(doneLabel);
    Logger.log(
      'Dispatched ' + jobIds.length + ' requisition(s) in one run: ' + jobIds.join(',')
    );
  } else {
    Logger.log(
      'Dispatch failed for ' + jobIds.join(',') + ' — nothing labelled, will retry next run'
    );
  }
}

// --- Helpers ----------------------------------------------------------------

/** Pull the Fieldglass job id out of subject or body text. */
function extractJobId(text) {
  var match = JOB_ID_RE.exec(text || '');
  return match ? match[1].trim().toUpperCase() : null;
}

/**
 * POST the repository_dispatch event. Returns true when GitHub accepted it.
 * `jobId` may be a single id or a comma-separated list — the workflow validates
 * each one before it reaches Playwright.
 */
function dispatch(token, jobId) {
  var url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/dispatches';
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({
      event_type: EVENT_TYPE,
      client_payload: { job_id: jobId, source: 'gmail-apps-script' },
    }),
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code === 204) return true;  // GitHub returns 204 No Content on success

  Logger.log('GitHub returned ' + code + ': ' + response.getContentText());
  return false;
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// --- One-time setup / manual test helpers -----------------------------------

/**
 * Run once from the editor. Creates both labels and installs the 1-minute
 * trigger, replacing any previous copy so re-running can't stack duplicates.
 */
function setup() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'checkForRequisitions') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger('checkForRequisitions').timeBased().everyMinutes(1).create();
  getOrCreateLabel(DONE_LABEL);
  getOrCreateLabel(FAILED_LABEL);
  Logger.log('Trigger installed — checkForRequisitions runs every minute.');
}

/**
 * Newest requisition id in the mailbox, ignoring the dispatched label — i.e.
 * the most recent id regardless of whether it has already been handled.
 * Used only by testDispatch(); the real flow never looks at handled threads.
 */
function newestRequisitionId() {
  var threads = GmailApp.search(SEARCH_QUERY.replace('-label:' + DONE_LABEL, ''), 0, 5);
  for (var i = 0; i < threads.length; i++) {
    var id = extractJobId(threads[i].getFirstMessageSubject());
    if (id) return id;
  }
  return null;
}

/**
 * Fire one dispatch by hand to prove the GitHub side works, without waiting for
 * a new requisition email. Run it, then watch the Actions tab.
 *
 * The id is resolved at run time rather than hardcoded: a pinned id silently
 * rots once that posting closes, and the run then reports "not in the
 * work-items list" — which reads as a broken pipeline when the pipeline is
 * fine. Precedence: TEST_JOB_ID script property, else the newest requisition
 * id in the mailbox.
 */
function testDispatch() {
  var props = PropertiesService.getScriptProperties();
  var jobId = props.getProperty('TEST_JOB_ID') || newestRequisitionId();

  if (!jobId) {
    Logger.log(
      'No id to test with: no TEST_JOB_ID script property, and no requisition ' +
        'email matched SEARCH_QUERY. Run dryRun() to check the search, or set ' +
        'TEST_JOB_ID to a currently-open posting.'
    );
    return;
  }

  var ok = dispatch(props.getProperty('GITHUB_TOKEN'), jobId);
  Logger.log(
    ok
      ? 'Dispatch accepted (204) for ' + jobId
      : 'Dispatch failed for ' + jobId + ' — see the log above'
  );
}

/**
 * Show what the current search matches and which ids would be extracted,
 * without dispatching or labelling anything.
 */
function dryRun() {
  var threads = GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS_PER_RUN);
  Logger.log(threads.length + ' matching thread(s)');
  for (var i = 0; i < threads.length; i++) {
    var subject = threads[i].getFirstMessageSubject();
    Logger.log('  ' + (extractJobId(subject) || '(no id)') + '  <- ' + subject);
  }
}
