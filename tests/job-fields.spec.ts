/**
 * Unit tests for utils/jobFields.ts — the detail-page label -> curated column
 * mapping added 2026-08-04 (field review: `Jobfield_Field glass.docx`).
 *
 * Pure functions, no browser or DB: runs under `npm test` on any machine.
 * The point of these is the fragile part of the mapping — the client-specific
 * compliance fields, whose Fieldglass label IS the full question text.
 */
import { test, expect } from '@playwright/test';
import { deriveJobFields, parseNumber, parseYesNo } from '../utils/jobFields';

// Labels/values exactly as harvested from the live portal (2026-08-03 scrape).
const LIVE_DETAILS: Record<string, string> = {
  'Job Code': 'Engineer-Level 3 - Senior (11 - 15 Years)',
  'Shift Type': 'Standard Shift (8-5)',
  'Maximum Submissions per Supplier': '2',
  'Total Hours': '2,088.00',
  'Submit Date': '06/24/2026 06:01 AM',
  'Business Unit': '1501 - Eng & Constr - 0010 - NextEra Energy Resources, LLC (1501)',
  'Travel Time': '10.000 %',
  'Enable Skills-Based Hiring': 'No',
  'Additional Job Details': 'Position Specific Description ...',
  'Will driving be required as part of position duties/work?': 'Yes',
  'Driving Record Validation': 'Some compliance boilerplate about driving records.',
  'Will the selected worker require unescorted badge access into Nuclear protected areas?': 'No',
  'Is NERC CIP unescorted physical or cyber access required for this assignment?': 'Yes',
  'Which NERC access is needed?': '',
};

test('promotes every Retain/Discuss field from live detail labels', () => {
  expect(deriveJobFields(LIVE_DETAILS)).toEqual({
    job_code: 'Engineer-Level 3 - Senior (11 - 15 Years)',
    shift_type: 'Standard Shift (8-5)',
    max_submissions: 2,
    total_hours: 2088,
    driving_required: true,
    additional_details: 'Position Specific Description ...',
    submit_date: '06/24/2026 06:01 AM',
    business_unit: '1501 - Eng & Constr - 0010 - NextEra Energy Resources, LLC (1501)',
    travel_time_pct: 10,
    skills_based_hiring: false,
    nuclear_badge_required: false,
    nerc_cip_required: true,
  });
});

test('missing or blank fields are null, never 0 or false', () => {
  const derived = deriveJobFields({ 'Additional Job Details': '', 'Total Hours': '' });
  expect(derived.additional_details).toBeNull();
  expect(derived.total_hours).toBeNull();
  expect(derived.driving_required).toBeNull();
  expect(derived.max_submissions).toBeNull();
  // Nothing scraped at all (detail page failed) => all nulls, no crash.
  expect(Object.values(deriveJobFields(null)).every((v) => v === null)).toBe(true);
});

test('regex fallback survives NextEra rewording the compliance questions', () => {
  const reworded = deriveJobFields({
    'Will driving be required for this assignment?': 'No',
    'Will the worker require unescorted badge access to protected areas?': 'Yes',
    'Is NERC-CIP access required?': 'Yes',
  });
  expect(reworded.driving_required).toBe(false);
  expect(reworded.nuclear_badge_required).toBe(true);
  expect(reworded.nerc_cip_required).toBe(true);
});

test('Discard-marked lookalike fields never feed a promoted column', () => {
  // "Driving Record Validation" (Discard) must not satisfy driving_required,
  // and "Which NERC access is needed?" (Discard) must not satisfy NERC CIP.
  const derived = deriveJobFields({
    'Driving Record Validation': 'Yes',
    'Which NERC access is needed?': 'Yes',
  });
  expect(derived.driving_required).toBeNull();
  expect(derived.nerc_cip_required).toBeNull();
});

test('numeric and Y/N parsing handles the portal formats', () => {
  expect(parseNumber('2,088.00')).toBe(2088);
  expect(parseNumber('0.000 %')).toBe(0);
  expect(parseNumber('14,616.00')).toBe(14616);
  expect(parseNumber('(No Value)')).toBeNull();
  expect(parseNumber('')).toBeNull();
  expect(parseYesNo('Yes')).toBe(true);
  expect(parseYesNo('no')).toBe(false);
  expect(parseYesNo('Maybe')).toBeNull();   // unknown stays unknown, not false
  expect(parseYesNo(null)).toBeNull();
});
