"""Action-oriented homepage starter chips (VMS Assistant Starter Questions spec).

Instead of static example prompts, the homepage shows up to four dynamic,
action-oriented chips chosen from LIVE VMS state, each with a real count:
New today / Needs attention / Closing soon / Ready to source (+ fallbacks).

Everything here is SQL-backed and deterministic — counts are exact and every
row cites its Job ID with an explicit reason (spec AC-04/06). No LLM: the chip
answers can't hallucinate. Dates arrive as US-format text from Fieldglass
("06/27/2026 12:00 PM US/Eastern", "07/06/2026") and are parsed here; the schema
deliberately stored them as text until a module needed real timestamps.

Guardrails (spec §10): only fields actually present are used; missing deadlines/
rates are marked, never fabricated; VMS priority is NOT exposed by Fieldglass to
us, so the attention score says so rather than inventing one.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chat import normalize_job_title  # noqa: E402

# Load the open jobs once per request — 56 rows today, cheap to compute in Python.
JOBS_SQL = """
select job_id, title, create_date, received_date, respond_by_date,
       positions, rate, location, category, labor_type, description, details,
       first_seen_at
from jobs
where is_open
"""

CLOSING_HOURS = 48   # "Closing soon — due within 48 hours"
AGING_DAYS = 7       # "open more than 7 days"

# Attention signal weights — configurable, NOT hard-coded assumptions (AC-08).
# Title grade/level is NOT a signal: every Fieldglass title has it and we
# auto-normalize, so it would flag 100% of jobs. Age is additive only — age
# alone must not flag a job (AC-08). A job qualifies at MIN_ATTENTION.
ATTENTION_WEIGHTS = {
    "deadline_urgent": 3,       # a valid deadline inside CLOSING_HOURS
    "missing_rate": 2,          # no usable bill rate
    "missing_description": 2,
    "no_deadline": 2,           # a real sourcing gap
    "aging": 1,                 # additive only
}
MIN_ATTENTION = 2


def _et_now() -> datetime:
    """Current time in US/Eastern (naive), so 'today'/'closing soon' match the
    Fieldglass timezone regardless of where the server runs."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York")).replace(tzinfo=None)
    except Exception:  # no tz database — approximate DST by month
        u = datetime.now(timezone.utc)
        offset = -4 if 3 <= u.month <= 11 else -5
        return (u + timedelta(hours=offset)).replace(tzinfo=None)


_TZ_SUFFIX = re.compile(r"\s+US/\w+\s*$", re.IGNORECASE)


def parse_vms_date(value) -> datetime | None:
    """Parse a Fieldglass date string (date-only or date+time, optional
    ' US/Eastern' suffix) to a naive datetime. None if unparseable/empty."""
    if not value:
        return None
    s = _TZ_SUFFIX.sub("", str(value).strip())
    for fmt in ("%m/%d/%Y %I:%M %p", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _details(job: dict) -> dict:
    d = job.get("details")
    return d if isinstance(d, dict) else {}


def _deadline(job: dict) -> datetime | None:
    """Submission deadline from the curated column, else the details map
    ('Respond by Date' then 'Submit Date')."""
    det = _details(job)
    for candidate in (job.get("respond_by_date"), det.get("Respond by Date"),
                      det.get("Submit Date")):
        dt = parse_vms_date(candidate)
        if dt:
            return dt
    return None


def _rate_missing(rate) -> bool:
    """True when there's no usable bill rate (empty, or every number is zero)."""
    s = (rate or "").strip()
    if not s:
        return True
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", s)]
    return not nums or max(nums) == 0.0


def _positions(job: dict) -> int:
    try:
        return int(re.sub(r"\D", "", str(job.get("positions") or "")) or 0)
    except ValueError:
        return 0


def _age_days(job: dict, now: datetime) -> int | None:
    created = parse_vms_date(job.get("create_date"))
    return (now - created).days if created else None


def _issues(job: dict) -> tuple[list[str], str]:
    """Real data-quality gaps for a job + its normalized title. (Title
    grade/level is deliberately NOT an issue — universal and auto-normalized.)"""
    norm, _meta = normalize_job_title(job.get("title") or "")
    issues = []
    if _rate_missing(job.get("rate")):
        issues.append(("missing_rate", "no usable bill rate"))
    if not (job.get("description") or "").strip():
        issues.append(("missing_description", "missing description"))
    if not _deadline(job):
        issues.append(("no_deadline", "no submission deadline"))
    return issues, norm


def _fmt_deadline(dt: datetime) -> str:
    return dt.strftime("%b %d, %Y %I:%M %p ET") if dt.hour or dt.minute \
        else dt.strftime("%b %d, %Y")


# --- per-chip builders: each returns a list of already-shaped rows -----------
# row = {job_id, title (normalized), line (summary), reason (why it appears)}

def _row(job, reason, extra=""):
    norm, _ = normalize_job_title(job.get("title") or "")
    loc = (job.get("location") or "").strip()
    line = " · ".join(p for p in [norm or job.get("title"), loc, extra] if p)
    return {"job_id": job["job_id"], "title": norm or job.get("title"),
            "line": line, "reason": reason}


def _new_today(jobs, now):
    today = now.date()
    out = []
    for j in jobs:
        c = parse_vms_date(j.get("create_date"))
        if c and c.date() == today:
            out.append(_row(j, "Opened today", f"opened {j.get('create_date')}"))
    return out


def _opened_this_week(jobs, now):
    out = []
    for j in jobs:
        c = parse_vms_date(j.get("create_date"))
        if c and 0 <= (now.date() - c.date()).days <= 7:
            out.append(_row(j, f"Opened {(now.date() - c.date()).days}d ago",
                            f"opened {j.get('create_date')}"))
    return out


def _closing_soon(jobs, now):
    out = []
    for j in jobs:
        dl = _deadline(j)
        if dl and now <= dl <= now + timedelta(hours=CLOSING_HOURS):
            hrs = int((dl - now).total_seconds() // 3600)
            out.append(_row(j, f"Closes in ~{hrs}h", f"due {_fmt_deadline(dl)}"))
    out.sort(key=lambda r: r["reason"])
    return out


def _needs_attention(jobs, now):
    scored = []
    for j in jobs:
        issues, _ = _issues(j)
        signals = list(issues)
        dl = _deadline(j)
        if dl and now <= dl <= now + timedelta(hours=CLOSING_HOURS):
            signals.append(("deadline_urgent", f"closes {_fmt_deadline(dl)}"))
        age = _age_days(j, now)
        if age is not None and age > AGING_DAYS:
            signals.append(("aging", f"open {age} days"))
        score = sum(ATTENTION_WEIGHTS.get(k, 0) for k, _ in signals)
        if score >= MIN_ATTENTION:
            reason = "; ".join(txt for _, txt in signals)
            row = _row(j, f"{reason} (attention {score}; no VMS priority available)")
            scored.append((score, row))
    scored.sort(key=lambda t: t[0], reverse=True)
    return [r for _, r in scored]


def _ready_to_source(jobs, now):
    out = []
    for j in jobs:
        issues, norm = _issues(j)
        blocking = {k for k, _ in issues} - {"no_deadline"}  # deadline optional (AC-09)
        loc = (j.get("location") or "").strip()
        if not blocking and norm and loc:
            out.append(_row(j, "Complete: title, rate, location, description present"))
    return out


def _highest_rate(jobs, now):
    def top(j):
        nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", j.get("rate") or "")]
        return max(nums) if nums else 0.0
    ranked = sorted((j for j in jobs if top(j) > 0), key=top, reverse=True)[:10]
    return [_row(j, f"Bill rate {j.get('rate')}", f"rate {j.get('rate')}") for j in ranked]


def _oldest(jobs, now):
    dated = [(j, _age_days(j, now)) for j in jobs]
    dated = [(j, a) for j, a in dated if a is not None]
    dated.sort(key=lambda t: t[1], reverse=True)
    return [_row(j, f"Open {a} days (since {j.get('create_date')})")
            for j, a in dated[:10]]


def _multiple_openings(jobs, now):
    out = [j for j in jobs if _positions(j) > 1]
    out.sort(key=_positions, reverse=True)
    return [_row(j, f"{_positions(j)} openings") for j in out]


# key -> (label, sublabel, question, icon, builder). Order = candidate priority;
# the four spec defaults first, then fallbacks used when a default is empty.
CHIP_DEFS = [
    ("new_today", "New today", "Posted today (ET)",
     "What new jobs opened today?", "calendar", _new_today),
    ("needs_attention", "Needs attention", "Missing or urgent details",
     "Which jobs need immediate attention?", "warning", _needs_attention),
    ("closing_soon", "Closing soon", f"Due within {CLOSING_HOURS} hours",
     f"Which jobs are closing in the next {CLOSING_HOURS} hours?", "clock", _closing_soon),
    ("ready_to_source", "Ready to source", "Complete job information",
     "Which jobs are ready for sourcing?", "people", _ready_to_source),
    # fallbacks (used to replace a zero-count default, spec AC-03)
    ("opened_this_week", "New this week", "Opened in the last 7 days",
     "Which jobs opened this week?", "calendar", _opened_this_week),
    ("multiple_openings", "Multiple openings", "More than one seat",
     "Which jobs have multiple openings?", "people", _multiple_openings),
    ("oldest", "Aging jobs", "Open the longest",
     "Show the oldest open jobs.", "clock", _oldest),
    ("highest_rate", "Highest rate", "Top bill rates",
     "Which open jobs have the highest bill rates?", "rate", _highest_rate),
]
_BUILDERS = {key: fn for key, *_rest, fn in CHIP_DEFS}
_DEFAULT_KEYS = ["new_today", "needs_attention", "closing_soon", "ready_to_source"]
_FALLBACK_KEYS = ["opened_this_week", "multiple_openings", "oldest", "highest_rate"]


def _load(conn) -> list[dict]:
    cur = conn.execute(JOBS_SQL)
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def select_chips(conn) -> list[dict]:
    """Compute live counts and choose up to four chips: the spec defaults, with
    any zero-count default replaced by the next non-empty fallback (AC-02/03)."""
    jobs = _load(conn)
    now = _et_now()
    counts = {key: len(_BUILDERS[key](jobs, now)) for key, *_ in CHIP_DEFS}
    meta = {key: (label, sub, q, icon)
            for key, label, sub, q, icon, _ in CHIP_DEFS}

    chosen, used = [], set()
    fallbacks = iter(_FALLBACK_KEYS)
    for key in _DEFAULT_KEYS:
        if counts[key] > 0:
            chosen.append(key); used.add(key)
        else:
            for fb in fallbacks:              # swap in the next non-empty fallback
                if fb not in used and counts[fb] > 0:
                    chosen.append(fb); used.add(fb); break
    # top up to 4 from any remaining non-empty candidate
    for key, *_ in CHIP_DEFS:
        if len(chosen) >= 4:
            break
        if key not in used and counts[key] > 0:
            chosen.append(key); used.add(key)

    out = []
    for key in chosen[:4]:
        label, sub, q, icon = meta[key]
        out.append({"key": key, "label": label, "sublabel": sub, "question": q,
                    "icon": icon, "count": counts[key]})
    return out


def answer(conn, key: str) -> dict | None:
    """Structured rows for one chip (cited Job IDs + reasons). None if unknown."""
    if key not in _BUILDERS:
        return None
    jobs = _load(conn)
    rows = _BUILDERS[key](jobs, _et_now())
    label = next((l for k, l, *_ in CHIP_DEFS if k == key), key)
    return {"key": key, "title": label, "count": len(rows), "rows": rows}
