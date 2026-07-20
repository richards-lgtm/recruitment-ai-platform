/**
 * PII masking for scraped Fieldglass jobs — runs before data is written to the
 * database (Supabase dev / VDHY045 prod). Pure functions, no network calls:
 * raw data never leaves the machine to get masked.
 *
 * What gets masked (validated against all 56 jobs in the 2026-07-09 scrape):
 *  1. NAME_FIELD values (Coordinator / Distributor) — replaced wholesale,
 *     including employee-ID suffixes like "(AXW0KXJ)".
 *  2. Those same person names anywhere in free text — the name list is
 *     harvested from the structured fields at runtime, so a name leaking into
 *     a description is still caught.
 *  3. Email addresses anywhere (e.g. cwp@nexteraenergy.com).
 *  4. US phone numbers anywhere (e.g. 561-694-4761). Separators are required
 *     so Fieldglass cost-center codes (C4.003526.60.C304, 0000103492) and
 *     zip+4 codes (33408-2657) don't false-positive.
 *
 * Known gap (documented, accepted 2026-07-15): a person name that appears
 * ONLY in free text and never in a Coordinator/Distributor field cannot be
 * caught by regex. Closing that gap needs an NER/LLM pass — see CLAUDE.md.
 */

const NAME_FIELDS = ["Coordinator", "Distributor"];

// Extra detail-page fields to redact wholesale. Empty by default — street
// addresses (Work Location) are corporate offices and recruiters need them
// for postings. Add keys here if governance decides otherwise.
const REDACT_FIELDS: string[] = [];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// (555) 123-4567 | 555-123-4567 | 555.123.4567 | 555 123 4567
// Lookarounds forbid adjacent digits so substrings of longer codes never match.
const PHONE_RE =
  /(?<!\d)(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?!\d)/g;

const MASK_NAME = "[REDACTED_NAME]";
const MASK_EMAIL = "[REDACTED_EMAIL]";
const MASK_PHONE = "[REDACTED_PHONE]";
const MASK_VALUE = "[REDACTED]";

export interface MaskStats {
  names: number;
  emails: number;
  phones: number;
  fieldsRedacted: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Harvest person names from the structured name fields of every job.
 * "Amy Wiegand (AXW0KXJ)" and "Alex Hopko - AGS Program Specialist" both
 * yield the leading "First Last" pair; the full raw value is kept too.
 */
function collectNames(jobs: object[]): Set<string> {
  const names = new Set<string>();
  for (const job of jobs) {
    const details = (job as Record<string, unknown>).details as
      | Record<string, unknown>
      | undefined;
    if (!details) continue;
    for (const field of NAME_FIELDS) {
      const raw = details[field];
      if (typeof raw !== "string" || raw.trim() === "") continue;
      names.add(raw.trim());
      const m = raw.match(/^([A-Z][a-zA-Z'-]+)\s+([A-Z][a-zA-Z'-]+)/);
      if (m) names.add(`${m[1]} ${m[2]}`);
    }
  }
  return names;
}

function maskString(
  value: string,
  nameRe: RegExp | null,
  stats: MaskStats,
): string {
  let out = value.replace(EMAIL_RE, () => {
    stats.emails++;
    return MASK_EMAIL;
  });
  out = out.replace(PHONE_RE, () => {
    stats.phones++;
    return MASK_PHONE;
  });
  if (nameRe) {
    out = out.replace(nameRe, () => {
      stats.names++;
      return MASK_NAME;
    });
  }
  return out;
}

function maskValue(
  value: unknown,
  nameRe: RegExp | null,
  stats: MaskStats,
): unknown {
  if (typeof value === "string") return maskString(value, nameRe, stats);
  if (Array.isArray(value)) return value.map((v) => maskValue(v, nameRe, stats));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (NAME_FIELDS.includes(k) && typeof v === "string" && v.trim() !== "") {
        stats.names++;
        out[k] = MASK_NAME;
      } else if (REDACT_FIELDS.includes(k) && typeof v === "string") {
        stats.fieldsRedacted++;
        out[k] = MASK_VALUE;
      } else {
        out[k] = maskValue(v, nameRe, stats);
      }
    }
    return out;
  }
  return value;
}

/**
 * Mask PII across a batch of scraped jobs. Returns masked copies (input is
 * not mutated) plus counts of what was replaced.
 */
export function maskJobs<T extends object>(
  jobs: T[],
): { jobs: T[]; stats: MaskStats } {
  const stats: MaskStats = { names: 0, emails: 0, phones: 0, fieldsRedacted: 0 };

  const names = collectNames(jobs);
  // Longest first so "Amy Wiegand (AXW0KXJ)" wins over "Amy Wiegand".
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const nameRe =
    sorted.length > 0
      ? new RegExp(`\\b(?:${sorted.map(escapeRegex).join("|")})\\b`, "gi")
      : null;

  const masked = jobs.map((job) => maskValue(job, nameRe, stats) as T);
  return { jobs: masked, stats };
}
