import { test, expect, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { writeJobsToDisk } from '../utils/writeJson';
import { createDbPool, fetchKnownJobIds, upsertJobs, touchSeen, markMissingClosed } from '../utils/db';

const FIELDGLASS_URL =
  process.env.FIELDGLASS_URL ?? 'https://www.us.fieldglass.cloud.sap/desktop.do?cf=1';
const FIELDGLASS_USERNAME = process.env.FIELDGLASS_USERNAME;
const FIELDGLASS_PASSWORD = process.env.FIELDGLASS_PASSWORD;
// Optional cap for quick smoke runs, e.g. FIELDGLASS_MAX_JOBS=3. Unset = scrape all.
const MAX_JOBS = Number(process.env.FIELDGLASS_MAX_JOBS) || Infinity;

interface JobPosting {
  jobId: string;
  title: string;
  client: string;
  site: string;
  location: string;
  positions: string;
  laborType: string;
  category: string;
  rate: string; // ST bill-rate range, e.g. "0.00 - 44.78"
  receivedDate: string; // when the posting hit our work-items queue
  createDate: string; // buyer's create date on the requisition
  respondByDate: string;
  hoursPerWeek: string;
  description: string;
  detailUrl: string;
  /** Every label/value field found on the detail page, keyed by its on-screen label. */
  details: Record<string, string>;
  /** Files attached to the posting, saved under output/attachments/<jobId>/. */
  attachments: JobAttachment[];
}

interface JobAttachment {
  name: string; // display name / filename
  file: string; // local path the file was saved to
}

/**
 * Download any files attached to the posting into output/attachments/<jobId>/.
 * NOTE: as of 2026-07-13 no open NEE posting carries an attachment (43/48 pages
 * show an empty "Attachments" section), so this is built defensively against
 * both Fieldglass download styles — direct href links and JS-driven downloads —
 * and should be re-verified against the first posting that has a real file.
 */
async function downloadAttachments(page: Page, jobId: string): Promise<JobAttachment[]> {
  const candidates = await page.$$eval('a', (anchors) =>
    anchors
      .map((a) => ({
        text: (a.textContent ?? '').trim().replace(/\s+/g, ' '),
        href: a.getAttribute('href') ?? '',
      }))
      .filter(
        (l) =>
          /attachment|file_download|getfile|download\.do/i.test(l.href) ||
          /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i.test(l.text),
      ),
  );

  const saved: JobAttachment[] = [];
  const dir = join('output', 'attachments', jobId);
  const seen = new Set<string>();

  for (const cand of candidates) {
    const key = `${cand.href}|${cand.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!cand.href || cand.href === '#' || cand.href.startsWith('javascript:')) {
        // JS-driven download: click the link and catch the browser download event.
        if (!cand.text) continue;
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15_000 }),
          page.locator('a', { hasText: cand.text }).first().click(),
        ]);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, download.suggestedFilename());
        await download.saveAs(file);
        saved.push({ name: cand.text, file });
      } else {
        // Direct link: fetch with the page's session cookies.
        const url = new URL(cand.href, page.url()).toString();
        const resp = await page.request.get(url);
        const type = resp.headers()['content-type'] ?? '';
        if (!resp.ok() || /text\/html/i.test(type)) continue; // navigation page, not a file
        const disp = resp.headers()['content-disposition'] ?? '';
        const fromDisp = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disp)?.[1];
        const name = (fromDisp ? decodeURIComponent(fromDisp) : '') || cand.text || 'attachment';
        const safeName = name.replace(/[^\w.\- ]+/g, '_').slice(0, 150);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, safeName);
        writeFileSync(file, await resp.body());
        saved.push({ name, file });
      }
    } catch (err) {
      console.warn(`  attachment "${cand.text || cand.href}" failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return saved;
}

/**
 * Harvest every label/value field on a job_posting_detail.do page.
 * The page mixes five row shapes (mapped against the live portal 2026-07-09):
 *   1. <tr><th>Label</th><td></td><td>value</td>          — rates (value in the LAST td)
 *   2. <tr><th>Label</th><td>value</td>                   — standard fields
 *   3. <tr><th>Label: value</th>                          — Work Location / Description (fused)
 *   4. <tr><td>Label</td><td>value</td>                   — flag fields (e.g. Skills-Based Hiring)
 *   5. <tr fgid="Label"><th><table>…</table></th>
 *        <td class="cfValue"><div class="diff-part-value">value</div></td>
 *                                                         — buyer's custom Q&A fields
 */
function harvestDetails(): Record<string, string> {
  const clean = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
  // textContent minus inline <script>/<style> (Fieldglass embeds tooltip JS in label cells)
  const textOf = (el: Element | null | undefined) => {
    if (!el) return '';
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('script, style').forEach((s) => s.remove());
    return clean(copy.textContent);
  };
  const out: Record<string, string> = {};
  const add = (label: string, value: string) => {
    if (!label) return;
    let key = label;
    for (let n = 2; key in out; n++) key = `${label} (${n})`; // e.g. ST vs OT "Bill Rate (2)"
    out[key] = value === '(No Value)' ? '' : value; // Fieldglass renders empty fields as "(No Value)"
  };

  for (const tr of document.querySelectorAll('tr')) {
    // Skip rows nested inside a custom-field row — the owning tr[fgid] handles them.
    const owner = tr.closest('tr[fgid]');
    if (owner && owner !== tr) continue;

    // shape 5 — custom Q&A: label from the fgid attribute, value from .diff-part-value
    const fgid = tr.getAttribute('fgid');
    if (fgid) {
      add(clean(fgid), textOf(tr.querySelector(':scope > td .diff-part-value') ?? tr.querySelector(':scope > td')));
      continue;
    }

    if (tr.querySelector('table')) continue; // container row wrapping a nested table
    const ths = Array.from(tr.querySelectorAll(':scope > th'));
    const tds = Array.from(tr.querySelectorAll(':scope > td'));

    if (ths.length > 0) {
      const label = textOf(ths[0]);
      if (/^Description:/i.test(label)) {
        add('Description', label.replace(/^Description:\s*/i, ''));
      } else if (tds.length === 0 && label.includes(':')) {
        // shape 3, e.g. "Work Location: 700 UNIVERSE BLVD. Juno Beach FL USA 33408"
        const i = label.indexOf(':');
        add(label.slice(0, i).trim(), label.slice(i + 1).trim());
      } else if (tds.length > 0) {
        // shapes 1 & 2 — the value is the last non-empty td
        const values = tds.map(textOf).filter(Boolean);
        add(label, values[values.length - 1] ?? '');
      }
      // th-only section headers ("Rates", "ST /Hr …") are intentionally skipped
    } else if (tds.length >= 2) {
      // shape 4 — label td + value td
      add(textOf(tds[0]), tds.slice(1).map(textOf).join(' ').trim());
    }
  }
  return out;
}

test('scrape open job postings from Fieldglass', async ({ page }) => {
  test.skip(!FIELDGLASS_USERNAME || !FIELDGLASS_PASSWORD,
    'Set FIELDGLASS_USERNAME and FIELDGLASS_PASSWORD env vars before running.');
  // 56 postings × one detail-page visit each — allow plenty of headroom.
  test.setTimeout(20 * 60_000);

  // Overlays appear at unpredictable times and intercept clicks: the TrustArc
  // cookie-consent banner loads asynchronously (sometimes only after login), and
  // a session-expiry modal can pop up during long runs. Locator handlers dismiss
  // them automatically whenever they would block an action.
  await page.addLocatorHandler(page.locator('#truste-consent-button'), async (btn) => {
    await btn.click();
  });
  const reviver = page.locator('#sessionReviverModal');
  await page.addLocatorHandler(reviver, async () => {
    const keepAlive = reviver.getByRole('button', { name: /continue|stay|extend|yes|ok/i }).first();
    if (await keepAlive.isVisible().catch(() => false)) {
      await keepAlive.click();
    } else {
      await reviver.locator('button').first().click();
    }
  });

  // --- Login (selectors confirmed against the live portal on 2026-07-09) ---
  await page.goto(FIELDGLASS_URL);
  await page.locator('#usernameId_new').waitFor({ timeout: 30_000 });
  await page.locator('#usernameId_new').fill(FIELDGLASS_USERNAME!);
  await page.locator('#passwordId_new').fill(FIELDGLASS_PASSWORD!);
  await page.locator('button[name="action"]', { hasText: 'Sign In' }).click();

  // --- Home dashboard -> "Job Posting - Respond" work-items list ---
  await page.getByText('My Work Items').first().waitFor({ timeout: 30_000 });
  await page.locator('text=/Job Posting - Respond/i').first().click();

  const rows = page.locator('#splitWindowList tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });

  // The list table keeps ALL rows in the DOM even though the UI pages them
  // 5 at a time, so read the whole set directly — no pagination needed.
  // Cell layout: [4]=received, [5]=jobId, [6]=title, [7]=buyer, [8]=site,
  // [9]=positions, [10]=laborType (cells 0-3 are internal ids).
  const listings = await page.$$eval('#splitWindowList tbody tr', (trs) =>
    trs
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td')).map(
          (td) => (td.textContent ?? '').trim(),
        );
        const link = tr.querySelector('a[href*="job_posting_detail.do"]');
        return {
          detailUrl: link ? (link as HTMLAnchorElement).href : '',
          receivedDate: cells[4] ?? '',
          jobId: cells[5] ?? '',
          title: cells[6] ?? '',
          client: cells[7] ?? '',
          site: cells[8] ?? '',
          positions: cells[9] ?? '',
          laborType: cells[10] ?? '',
        };
      })
      .filter((l) => l.jobId && l.detailUrl),
  );
  console.log(`Found ${listings.length} open job postings in the work-items list.`);

  // --- Incremental diff against the DB (agreed 2026-07-09): only visit detail
  // pages for postings we haven't stored yet. Without DATABASE_URL the spec
  // falls back to the original full-scrape, JSON-only behavior.
  const db = createDbPool();
  let knownIds = new Set<string>();
  if (db) {
    knownIds = await fetchKnownJobIds(db);
    console.log(`DB: ${knownIds.size} jobs already stored — scraping new postings only.`);
  }
  const newListings = db ? listings.filter((l) => !knownIds.has(l.jobId)) : listings;

  // --- Visit each posting's detail page for rate, description, dates, location ---
  const toScrape = newListings.slice(0, Math.min(newListings.length, MAX_JOBS));
  const jobs: JobPosting[] = [];

  try {
    for (const [i, listing] of toScrape.entries()) {
      try {
        await page.goto(listing.detailUrl, { waitUntil: 'domcontentloaded' });
        await page.locator('h1').first().waitFor({ timeout: 30_000 });

        // One DOM pass per page: every label/value field the portal shows.
        const details = await page.evaluate(harvestDetails);
        const attachments = await downloadAttachments(page, listing.jobId);
        if (attachments.length) {
          console.log(`  downloaded ${attachments.length} attachment(s) for ${listing.jobId}`);
        }

        jobs.push({
          ...listing,
          title: (await page.locator('h1').first().innerText()).trim() || listing.title,
          location: details['Location'] ?? '',
          category: details['Category'] ?? '',
          createDate: details['Create Date'] ?? '',
          respondByDate: details['Respond by Date'] ?? '',
          hoursPerWeek: details['Hours per Week'] ?? '',
          rate: details['Bill Rate'] ?? '', // first occurrence = ST rate; OT is details['Bill Rate (2)']
          description: details['Description'] ?? '',
          details,
          attachments,
        });
        console.log(`[${i + 1}/${toScrape.length}] ${listing.jobId} — ${jobs[jobs.length - 1].title}`);
      } catch (err) {
        if (page.isClosed()) throw err; // browser/window gone — stop, partial output below
        // Detail page failed for this job only: keep the list-level fields and move on.
        console.warn(`[${i + 1}/${toScrape.length}] ${listing.jobId} — detail scrape failed, keeping list fields (${(err as Error).message.split('\n')[0]})`);
        jobs.push({
          ...listing,
          location: '', category: '', createDate: '', respondByDate: '',
          hoursPerWeek: '', rate: '', description: '', details: {}, attachments: [],
        });
      }
    }
  } finally {
    // Always persist what we have — a mid-run browser close shouldn't lose 30+ scraped jobs.
    if (jobs.length > 0) {
      const filePath = writeJobsToDisk(jobs);
      console.log(`Wrote ${jobs.length}/${toScrape.length} job postings to ${filePath}`);
    }

    if (db) {
      try {
        if (jobs.length > 0) {
          // PII is masked inside upsertJobs — only masked data reaches the DB.
          const stats = await upsertJobs(db, jobs);
          console.log(
            `DB: upserted ${jobs.length} job(s) ` +
            `(masked ${stats.names} names, ${stats.emails} emails, ${stats.phones} phones).`,
          );
        }
        // Known postings still listed: bump last_seen_at. Stored postings that
        // vanished from the list: mark closed.
        await touchSeen(db, listings.filter((l) => knownIds.has(l.jobId)).map((l) => l.jobId));
        const closed = await markMissingClosed(db, listings.map((l) => l.jobId));
        if (closed > 0) console.log(`DB: marked ${closed} job(s) closed (gone from work-items list).`);
      } catch (err) {
        console.error(`DB persistence failed (JSON output above is intact): ${(err as Error).message}`);
        throw err;
      } finally {
        await db.end();
      }
    }
  }

  expect(jobs.length).toBe(toScrape.length);
});
