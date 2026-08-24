/**
 * Detail-page label -> curated column mapping for the fields the field review
 * (`Jobfield_Field glass.docx`) marked **Retain** or **Discuss**.
 *
 * Why a mapper instead of extracting these in the scrape spec: the raw label
 * map (`details` jsonb) is already the complete, audited record of the page.
 * Deriving columns from it means (a) the same code promotes fields on a live
 * scrape and on a backfill of already-stored rows, and (b) values are taken
 * AFTER utils/maskJobs.ts has run, so a promoted column can never leak PII
 * that the jsonb blob had masked.
 *
 * Labels are matched exactly first, then by regex fallback. The client-specific
 * compliance fields are Fieldglass custom questions whose label IS the full
 * question text ("Will driving be required as part of position duties/work?"),
 * so NextEra rewording the question would silently null the column — the regex
 * fallback keeps that a cosmetic change rather than data loss. Anything a spec
 * misses still sits in `details`.
 *
 * Fields the review marked Discard (Coordinator/Distributor, Auto Invoice Type,
 * Contingent Type, Buyer Reference, timesheet/finance fields, furlough and
 * NERC/FERC granularity) are deliberately NOT promoted — they stay in `details`
 * only. Coordinator/Distributor are masked before they ever reach the DB.
 */

/** Curated column values derived from a job's detail-page label map. */
export interface DerivedJobFields {
  // --- Retain ---
  job_code: string | null;
  shift_type: string | null;
  max_submissions: number | null;
  total_hours: number | null;
  driving_required: boolean | null;
  additional_details: string | null;
  // --- Discuss (kept per the 2026-08-04 decision to retain broadly for now) ---
  submit_date: string | null;
  business_unit: string | null;
  travel_time_pct: number | null;
  skills_based_hiring: boolean | null;
  nuclear_badge_required: boolean | null;
  nerc_cip_required: boolean | null;
}

/** Column order used by both the upsert and the backfill. */
export const DERIVED_COLUMNS: (keyof DerivedJobFields)[] = [
  'job_code',
  'shift_type',
  'max_submissions',
  'total_hours',
  'driving_required',
  'additional_details',
  'submit_date',
  'business_unit',
  'travel_time_pct',
  'skills_based_hiring',
  'nuclear_badge_required',
  'nerc_cip_required',
];

interface FieldSpec {
  labels: string[];   // exact on-screen labels, tried in order
  match?: RegExp;     // fallback: first key matching this wins
}

export const SPECS: Record<keyof DerivedJobFields, FieldSpec> = {
  job_code:           { labels: ['Job Code'] },
  shift_type:         { labels: ['Shift Type'] },
  max_submissions:    { labels: ['Maximum Submissions per Supplier'] },
  total_hours:        { labels: ['Total Hours'] },   // "2,088.00"
  additional_details: { labels: ['Additional Job Details'] },
  submit_date:        { labels: ['Submit Date'] },   // US-format, see schema.sql
  business_unit:      { labels: ['Business Unit'] },
  travel_time_pct:    { labels: ['Travel Time', 'Travel Time %'] },  // "0.000 %"
  skills_based_hiring: { labels: ['Enable Skills-Based Hiring'] },
  driving_required: {
    labels: ['Will driving be required as part of position duties/work?'],
    // NOT /driving/ alone — "Driving Record Validation" is a Discard field.
    match: /driving\b.*\brequired/i,
  },
  nuclear_badge_required: {
    labels: ['Will the selected worker require unescorted badge access into Nuclear protected areas?'],
    match: /unescorted badge access/i,
  },
  nerc_cip_required: {
    labels: ['Is NERC CIP unescorted physical or cyber access required for this assignment?'],
    // Hyphen/space tolerant ("NERC CIP", "NERC-CIP"). "Which NERC access is
    // needed?" (Discard) says "NERC access", not "NERC CIP", so it can't match.
    match: /NERC[\s-]*CIP/i,
  },
};

function rawValue(details: Record<string, string>, spec: FieldSpec): string | null {
  for (const label of spec.labels) {
    const v = details[label];
    if (v !== undefined) return v;
  }
  if (spec.match) {
    for (const [key, v] of Object.entries(details)) {
      if (spec.match.test(key)) return v;
    }
  }
  return null;
}

/** "Yes"/"No" checkbox answers; anything unrecognised stays NULL (unknown). */
export function parseYesNo(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (['yes', 'y', 'true', 'checked'].includes(v)) return true;
  if (['no', 'n', 'false', 'unchecked'].includes(v)) return false;
  return null;
}

/** "2,088.00" -> 2088, "0.000 %" -> 0, "" -> null. */
export function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/,/g, '').replace(/[^0-9.\-]/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Promote the Retain/Discuss fields out of a job's detail-page label map into
 * curated column values. Missing or unparseable values are NULL — the raw
 * string always remains in `details`.
 */
export function deriveJobFields(
  details: Record<string, string> | null | undefined,
): DerivedJobFields {
  const map = details ?? {};
  const raw = (col: keyof DerivedJobFields) => rawValue(map, SPECS[col]);
  // Per-type readers, so each column's declared type is checked at compile time
  // rather than funnelled through one loosely-typed loop.
  const text = (col: keyof DerivedJobFields): string | null => {
    const v = (raw(col) ?? '').trim();
    return v === '' ? null : v;
  };
  const num = (col: keyof DerivedJobFields) => parseNumber(raw(col));
  const int = (col: keyof DerivedJobFields) => {
    const n = parseNumber(raw(col));
    return n === null ? null : Math.round(n);
  };
  const bool = (col: keyof DerivedJobFields) => parseYesNo(raw(col));

  return {
    job_code: text('job_code'),
    shift_type: text('shift_type'),
    max_submissions: int('max_submissions'),
    total_hours: num('total_hours'),
    driving_required: bool('driving_required'),
    additional_details: text('additional_details'),
    submit_date: text('submit_date'),
    business_unit: text('business_unit'),
    travel_time_pct: num('travel_time_pct'),
    skills_based_hiring: bool('skills_based_hiring'),
    nuclear_badge_required: bool('nuclear_badge_required'),
    nerc_cip_required: bool('nerc_cip_required'),
  };
}
