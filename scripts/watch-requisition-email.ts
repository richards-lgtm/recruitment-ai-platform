/**
 * Gmail requisition watcher — the email trigger for the Fieldglass scraper.
 *
 * Turns a "New requisition from NextEra Energy submitted [Buyer: …,
 * Requisition ID: NEEJP00020528, Requisition Title: …]" email into an immediate
 * single-job scrape, instead of waiting for the next scheduled full pass:
 *
 *   IMAP IDLE on the inbox → new mail → subject matches the requisition pattern
 *   → pull the Requisition ID out of the subject → run the scrape spec with
 *   FIELDGLASS_JOB_IDS=<id> → posting lands in output/ + the DB (masked).
 *
 * Usage:
 *   npm run watch:email                        long-lived listener (IMAP IDLE)
 *   npm run watch:email -- --once              one check-and-exit pass (cron/CI)
 *   npm run watch:email -- --dry-run           detect + log, never run the scraper
 *   npm run watch:email -- --backfill=3        also sweep the last 3 days of mail
 *   npm run watch:email -- --job=NEEJP00020528 force-scrape one id, no IMAP at all
 *   npm run watch:email -- --force             ignore the processed-id list
 *
 * Auth note: Gmail stopped accepting plain account passwords over IMAP in 2022,
 * so GMAIL_APP_PASSWORD must be a 16-character Google **App Password**
 * (https://myaccount.google.com/apppasswords — needs 2-Step Verification on the
 * account). The normal mailbox password will fail with AUTHENTICATIONFAILED.
 *
 * Governance: the watcher only ever reads mail headers/bodies in memory to pull
 * a requisition ID — no message content is stored. The state file (job ids +
 * titles + UID watermark) lives in the gitignored output/ directory.
 */
import { ImapFlow } from 'imapflow';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import 'dotenv/config';

// --- Config (all overridable via .env) ---------------------------------------
const HOST = process.env.GMAIL_IMAP_HOST ?? 'imap.gmail.com';
const PORT = Number(process.env.GMAIL_IMAP_PORT ?? 993);
const USER = process.env.GMAIL_USER;
// Google prints app passwords in four space-separated groups — strip whitespace.
const PASS = (process.env.GMAIL_APP_PASSWORD ?? '').replace(/\s+/g, '');
const MAILBOX = process.env.GMAIL_MAILBOX ?? 'INBOX';
/** Subject test that identifies a new-requisition notification. */
const SUBJECT_RE = new RegExp(
  process.env.GMAIL_REQUISITION_SUBJECT ?? 'new requisition.*submitted',
  'i',
);
/** Sender must contain this (case-insensitive). Empty string = accept any sender. */
const SENDER = (process.env.GMAIL_REQUISITION_FROM ?? 'nextera@vdartinc.com').toLowerCase();
/** Capture group 1 is the Fieldglass job id. */
const JOB_ID_RE = new RegExp(
  process.env.GMAIL_JOB_ID_PATTERN ?? 'Requisition ID:\\s*([A-Za-z0-9_-]+)',
  'i',
);
/** Mark triggering mail as read. Off by default — don't touch the user's inbox. */
const MARK_SEEN = process.env.GMAIL_MARK_SEEN === '1';
const STATE_FILE = process.env.GMAIL_WATCH_STATE ?? join('output', 'email-watch-state.json');
/** Wait this long after the first email so a burst of requisitions scrapes in one run. */
const DEBOUNCE_MS = Number(process.env.GMAIL_DEBOUNCE_SECONDS ?? 20) * 1_000;
/**
 * Retry ladder for postings that aren't in the work-items list yet — the
 * notification email regularly beats the Fieldglass UI by a few minutes.
 * One entry per attempt after the first; length = how many retries before we
 * give up and leave the posting to the next scheduled full scrape.
 */
const RETRY_MINUTES = (process.env.GMAIL_RETRY_MINUTES ?? '3,7,15,30,60')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
/** Headless by default: a watcher popping browser windows open is disruptive. */
const SCRAPE_HEADLESS = process.env.GMAIL_SCRAPE_HEADLESS ?? '1';

// --- CLI flags ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const ONCE = flag('once');
const DRY_RUN = flag('dry-run');
const FORCE = flag('force');
const BACKFILL_DAYS = Number(opt('backfill') ?? process.env.GMAIL_BACKFILL_DAYS ?? 0);
const MANUAL_JOB = opt('job');

const ROOT = join(__dirname, '..');
const SPEC = 'tests/fieldglass-scrape.spec.ts';
const PW_CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Pure helpers (unit-testable, no IMAP/network) ---------------------------

/** True when a subject line looks like a new-requisition notification. */
export function isRequisitionSubject(subject: string): boolean {
  return SUBJECT_RE.test(subject ?? '');
}

/** Pull the Fieldglass job id (e.g. NEEJP00020528) out of subject or body text. */
export function extractJobId(text: string): string | null {
  const m = JOB_ID_RE.exec(text ?? '');
  const id = m?.[1]?.trim().toUpperCase();
  // Guard the value that becomes FIELDGLASS_JOB_IDS: ids are alphanumeric only.
  return id && /^[A-Z0-9_-]+$/.test(id) ? id : null;
}

/**
 * Requisition title from the subject's bracketed block. Terminated by the next
 * "…, Requisition <field>:" or the closing bracket — a plain comma split would
 * break on "NextEra Energy, Inc. (Florida Power & Light Co.)".
 */
export function extractTitle(subject: string): string {
  const m = /Requisition Title:\s*(.+?)\s*(?:,\s*Requisition\s|\]\s*$|$)/i.exec(subject ?? '');
  return m?.[1]?.trim() ?? '';
}

/** True when any of the message's sender-ish addresses matches SENDER. */
export function senderMatches(addresses: string[]): boolean {
  if (!SENDER) return true;
  return addresses.some((a) => (a ?? '').toLowerCase().includes(SENDER));
}

/**
 * Best-effort plain-text view of a raw MIME message: undo quoted-printable soft
 * breaks and hex escapes so a requisition id in the body is still findable.
 * Only a fallback — the subject is the primary source of the id.
 */
export function decodeSource(buf: Buffer | string): string {
  const raw = typeof buf === 'string' ? buf : buf.toString('utf8');
  return raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}

// --- State (survives restarts; keyed on job id, not message id, because the
// same requisition can be emailed more than once) ----------------------------
interface PendingJob {
  attempts: number;
  firstSeen: string;
  title?: string;
}
interface WatchState {
  /** Highest inbox UID already examined. */
  lastUid: number;
  /** jobId -> ISO timestamp of the run that settled it. */
  processed: Record<string, string>;
  /** jobId -> retry bookkeeping for postings not yet visible in the portal. */
  pending: Record<string, PendingJob>;
}

const EMPTY_STATE: WatchState = { lastUid: 0, processed: {}, pending: {} };
let state: WatchState = { ...EMPTY_STATE };

function loadState(): WatchState {
  if (!existsSync(STATE_FILE)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<WatchState>;
    return {
      lastUid: Number(parsed.lastUid) || 0,
      processed: parsed.processed ?? {},
      pending: parsed.pending ?? {},
    };
  } catch (err) {
    log(`state file unreadable, starting fresh: ${(err as Error).message}`);
    return { ...EMPTY_STATE };
  }
}

function saveState(): void {
  // Keep the processed list from growing without bound (oldest entries drop).
  const entries = Object.entries(state.processed);
  if (entries.length > 500) {
    entries.sort((a, b) => a[1].localeCompare(b[1]));
    state.processed = Object.fromEntries(entries.slice(-500));
  }
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Scrape invocation -------------------------------------------------------

interface ScrapeResult {
  ok: boolean;
  /** Ids the spec reported as absent from the work-items list (retryable). */
  notFound: string[];
}

/**
 * Run the scrape spec in targeted mode. Streams its output through so the
 * watcher's log reads like a normal scrape run, then looks for the spec's
 * TARGET_NOT_FOUND markers.
 */
function runScrape(jobIds: string[]): Promise<ScrapeResult> {
  const ids = jobIds.join(',');
  log(`launching targeted scrape for ${ids}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PW_CLI, 'test', SPEC, '--reporter=list'], {
      cwd: ROOT,
      env: {
        ...process.env,
        FIELDGLASS_JOB_IDS: ids,
        FIELDGLASS_HEADLESS: SCRAPE_HEADLESS,
        // Neutralise any FIELDGLASS_MAX_JOBS smoke-run cap from .env — a targeted
        // run must be free to visit every posting it was asked for.
        FIELDGLASS_MAX_JOBS: String(jobIds.length),
      },
    });

    let output = '';
    const relay = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);

    child.on('error', (err) => {
      log(`scrape could not start: ${err.message}`);
      resolve({ ok: false, notFound: jobIds });
    });
    child.on('close', (code) => {
      const notFound = [...output.matchAll(/TARGET_NOT_FOUND:\s*(\S+)/g)].map((m) =>
        m[1].toUpperCase(),
      );
      log(`scrape exited with code ${code}${notFound.length ? `; not in portal yet: ${notFound.join(',')}` : ''}`);
      resolve({ ok: code === 0, notFound });
    });
  });
}

// --- Queue: one scrape at a time, debounced, with a retry ladder -------------
let running = false;
let timer: NodeJS.Timeout | null = null;

function queueJob(jobId: string, title: string): void {
  if (!FORCE && state.processed[jobId]) {
    log(`skip ${jobId} — already handled (${state.processed[jobId]})`);
    return;
  }
  if (state.pending[jobId]) return; // already queued
  state.pending[jobId] = { attempts: 0, firstSeen: new Date().toISOString(), title };
  log(`queued ${jobId}${title ? ` — ${title}` : ''}`);
}

function nextDelayMs(): number {
  // Slowest pending job sets the pace, so one lagging posting doesn't hammer the portal.
  const attempts = Math.max(...Object.values(state.pending).map((p) => p.attempts), 0);
  const minutes = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
  return Math.max(minutes, 1) * 60_000;
}

function schedule(delayMs: number, why: string): void {
  // One-shot modes (--once, --job) make a single attempt and exit; anything
  // unresolved stays in state.pending for the next run to pick up.
  if (ONCE || MANUAL_JOB) return;
  if (timer) clearTimeout(timer);
  log(`next attempt in ${Math.round(delayMs / 1000)}s (${why})`);
  timer = setTimeout(() => {
    timer = null;
    void pump();
  }, delayMs);
}

/** Scrape everything currently pending, then reschedule whatever didn't settle. */
async function pump(): Promise<void> {
  if (running) return;
  const ids = Object.keys(state.pending);
  if (ids.length === 0) return;

  if (DRY_RUN) {
    log(`dry run — would scrape ${ids.join(',')}`);
    for (const id of ids) delete state.pending[id];
    saveState();
    return;
  }

  running = true;
  try {
    const { ok, notFound } = await runScrape(ids);
    const stamp = new Date().toISOString();
    for (const id of ids) {
      const job = state.pending[id];
      if (!job) continue;
      const settled = ok && !notFound.includes(id);
      if (settled) {
        state.processed[id] = stamp;
        delete state.pending[id];
        log(`done ${id}${job.title ? ` — ${job.title}` : ''}`);
        continue;
      }
      job.attempts += 1;
      if (job.attempts > RETRY_MINUTES.length) {
        // Out of retries: record it so the same email can't loop forever. The
        // scheduled full scrape will still pick the posting up when it appears.
        state.processed[id] = `${stamp} (gave up after ${job.attempts} attempts)`;
        delete state.pending[id];
        log(`GIVING UP on ${id} after ${job.attempts} attempts — leaving it to the scheduled scrape`);
      }
    }
    saveState();
  } finally {
    running = false;
  }

  if (Object.keys(state.pending).length > 0) schedule(nextDelayMs(), 'retry');
}

// --- IMAP --------------------------------------------------------------------

/** Inspect one message; queue it when it is a requisition notification. */
async function considerMessage(
  client: ImapFlow,
  msg: { uid: number; envelope?: any },
): Promise<boolean> {
  const env = msg.envelope ?? {};
  const subject: string = env.subject ?? '';
  const addresses: string[] = [
    ...(env.from ?? []),
    ...(env.sender ?? []),
    ...(env.replyTo ?? []),
  ].map((a: { address?: string }) => a?.address ?? '');

  if (!isRequisitionSubject(subject)) return false;
  if (!senderMatches(addresses)) {
    log(`uid ${msg.uid}: subject matched but sender ${addresses.join('/') || '(none)'} did not`);
    return false;
  }

  let jobId = extractJobId(subject);
  if (!jobId) {
    // Rare: subject truncated / reworded. Fall back to scanning the raw body.
    const full = await client.fetchOne(String(msg.uid), { source: true }, { uid: true });
    const body = full && (full as any).source ? decodeSource((full as any).source) : '';
    jobId = extractJobId(body);
  }
  if (!jobId) {
    log(`uid ${msg.uid}: requisition email but no id found — subject: ${subject.slice(0, 120)}`);
    return false;
  }

  queueJob(jobId, extractTitle(subject));
  if (MARK_SEEN) await client.messageFlagsAdd(String(msg.uid), ['\\Seen'], { uid: true });
  return true;
}

/** Fetch + consider every message in a UID list. Returns how many were queued. */
async function scanUids(client: ImapFlow, uids: number[]): Promise<number> {
  if (uids.length === 0) return 0;
  let queued = 0;
  for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
    if (await considerMessage(client, msg as any)) queued += 1;
    if (msg.uid > state.lastUid) state.lastUid = msg.uid;
  }
  saveState();
  return queued;
}

/** Everything above the UID watermark. */
async function scanNew(client: ImapFlow): Promise<number> {
  const from = state.lastUid + 1;
  let uids: number[] = [];
  try {
    // IMAP's "n:*" always yields at least the last message, so filter explicitly.
    uids = ((await client.search({ uid: `${from}:*` }, { uid: true })) || []).filter(
      (u) => u >= from,
    );
  } catch {
    uids = []; // empty mailbox / nothing above the watermark
  }
  return scanUids(client, uids);
}

async function connect(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: USER!, pass: PASS },
    logger: false,
    // Gmail drops an idle connection after ~29 min; imapflow renews IDLE itself.
    emitLogs: false,
  });
  client.on('error', (err: Error) => log(`imap error: ${err.message}`));
  await client.connect();
  await client.mailboxOpen(MAILBOX);
  log(`connected to ${MAILBOX} as ${USER} (${(client.mailbox as any)?.exists ?? '?'} messages)`);
  return client;
}

async function watch(): Promise<void> {
  let client = await connect();

  // First run with no state: start from "now" instead of replaying the whole
  // inbox. --backfill=<days> opts into a sweep of recent mail (useful for testing).
  const fresh = state.lastUid === 0;
  if (fresh && BACKFILL_DAYS <= 0) {
    state.lastUid = Math.max(Number((client.mailbox as any)?.uidNext ?? 1) - 1, 0);
    saveState();
    log(`no previous state — watching forward from uid ${state.lastUid} (use --backfill=<days> to sweep older mail)`);
  }
  if (BACKFILL_DAYS > 0) {
    const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
    const uids = ((await client.search({ since }, { uid: true })) || []) as number[];
    log(`backfill: ${uids.length} message(s) since ${since.toISOString().slice(0, 10)}`);
    await scanUids(client, uids);
  }

  const carried = Object.keys(state.pending);
  if (carried.length) log(`resuming ${carried.length} pending job(s) from state: ${carried.join(',')}`);

  const queued = await scanNew(client);
  if (queued || carried.length) schedule(DEBOUNCE_MS, 'startup queue');

  if (ONCE) {
    if (Object.keys(state.pending).length > 0) await pump();
    await client.logout();
    const left = Object.keys(state.pending);
    log(left.length ? `exiting with ${left.length} job(s) still pending: ${left.join(',')}` : 'exiting — nothing pending');
    return;
  }

  // Long-lived listener: imapflow keeps the mailbox in IDLE and emits `exists`
  // whenever new mail arrives.
  client.on('exists', () => {
    void (async () => {
      try {
        const n = await scanNew(client);
        if (n > 0) schedule(DEBOUNCE_MS, `${n} new requisition email(s)`);
      } catch (err) {
        log(`scan after new mail failed: ${(err as Error).message}`);
      }
    })();
  });

  // Reconnect loop: a dropped socket shouldn't end the watch.
  let backoffMs = 15_000;
  client.on('close', () => {
    void (async () => {
      for (;;) {
        log(`imap connection closed — reconnecting in ${backoffMs / 1000}s`);
        await new Promise((r) => setTimeout(r, backoffMs));
        try {
          client = await connect();
          backoffMs = 15_000;
          const n = await scanNew(client);
          if (n > 0) schedule(DEBOUNCE_MS, 'mail arrived while disconnected');
          return;
        } catch (err) {
          log(`reconnect failed: ${(err as Error).message}`);
          backoffMs = Math.min(backoffMs * 2, 10 * 60_000);
        }
      }
    })();
  });

  log('watching for new requisition emails — Ctrl+C to stop');
  const shutdown = async () => {
    log('shutting down');
    if (timer) clearTimeout(timer);
    try {
      await client.logout();
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function main(): Promise<void> {
  state = loadState();

  // --job=<id>: manual trigger, no mailbox involved.
  if (MANUAL_JOB) {
    const id = extractJobId(`Requisition ID: ${MANUAL_JOB}`);
    if (!id) throw new Error(`--job=${MANUAL_JOB} is not a valid job id`);
    queueJob(id, '');
    await pump();
    if (state.pending[id]) {
      log(`${id} was not scraped — not in the work-items list (or the scrape failed); it stays pending`);
      process.exitCode = 1;
    }
    return;
  }

  if (!USER || !PASS) {
    console.error(
      'Set GMAIL_USER and GMAIL_APP_PASSWORD in .env before running the watcher.\n' +
        'GMAIL_APP_PASSWORD must be a 16-character Google App Password\n' +
        '(https://myaccount.google.com/apppasswords) — Gmail rejects normal\n' +
        'account passwords over IMAP.',
    );
    process.exit(1);
  }
  await watch();
}

// Guarded so the pure helpers above can be imported (tests, other scripts)
// without starting a mailbox session.
if (require.main === module) {
  main().catch((err) => {
    log(`fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
