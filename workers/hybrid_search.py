"""Hybrid search over embedded job chunks — keyword + vector, fused with RRF.

Runs two retrievals over job_chunks and fuses them with Reciprocal Rank
Fusion (k=60):
  - full-text:  websearch_to_tsquery + ts_rank via the GIN index
  - semantic:   BGE-M3 query embedding + cosine distance via the HNSW index

Results are aggregated per job (best chunk per method), filtered to open
postings, and ranked by the fused score. If the query is all stopwords the
text branch matches nothing and ranking gracefully degrades to vector-only.

Note: websearch_to_tsquery ANDs all terms, so a long natural-language query
usually gets no keyword hits (vector carries it) — keyword boosting kicks in
for short, targeted terms. Use quotes for phrases and OR between alternatives
(e.g. 'estimator OR "cost engineer"').

Run:  py workers/hybrid_search.py "solar project manager with estimating" [limit]
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
from embed_worker import get_conn_string, load_model  # noqa: E402

# How many chunk hits each retrieval contributes before fusion. Generous vs.
# the final limit so a job strong in one method can't crowd the other out.
POOL = 50
RRF_K = 60  # standard damping constant: 1/(k + rank)

SEARCH_SQL = """
with vec_chunks as (
    -- ORDER BY the raw <=> expression + LIMIT keeps this on the HNSW index
    select job_id, embedding <=> %(vec)s::vector as dist
    from job_chunks
    where embedding is not null
    order by embedding <=> %(vec)s::vector
    limit %(pool)s
),
vec_jobs as (
    select job_id, row_number() over (order by min(dist)) as rnk
    from vec_chunks
    group by job_id
),
txt_jobs as (
    select job_id,
           row_number() over (order by max(score) desc) as rnk
    from (
        select job_id,
               ts_rank(to_tsvector('english', content), q) as score
        from job_chunks, websearch_to_tsquery('english', %(query)s) q
        where to_tsvector('english', content) @@ q
        order by score desc
        limit %(pool)s
    ) hits
    group by job_id
),
fused as (
    select coalesce(v.job_id, t.job_id) as job_id,
           coalesce(1.0 / (%(rrf_k)s + v.rnk), 0)
         + coalesce(1.0 / (%(rrf_k)s + t.rnk), 0) as rrf,
           v.rnk as vec_rank,
           t.rnk as txt_rank
    from vec_jobs v
    full outer join txt_jobs t using (job_id)
)
select f.job_id, j.title, round(f.rrf::numeric, 4) as score,
       f.vec_rank, f.txt_rank
from fused f
join jobs j using (job_id)
where j.is_open
order by f.rrf desc, f.job_id
limit %(limit)s
"""


def embed_query(model, query: str) -> str:
    """Encode the query and return a pgvector literal. Kept separate from the
    SQL so callers with a connection pool don't hold a connection through the
    slow (1-3s CPU) encode step."""
    vec = model.encode([query])["dense_vecs"][0]
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def run_search(conn, vec_literal: str, query: str, limit: int = 8) -> list[tuple]:
    """Run the fused retrieval on an existing connection."""
    params = {
        "vec": vec_literal,
        "query": query,
        "pool": POOL,
        "rrf_k": RRF_K,
        "limit": limit,
    }
    with conn.cursor() as cur:
        cur.execute(SEARCH_SQL, params)
        return cur.fetchall()


def search(conn_string: str, model, query: str, limit: int = 8) -> list[tuple]:
    """Convenience wrapper for CLI callers: encode, connect, search."""
    literal = embed_query(model, query)
    with psycopg.connect(conn_string) as conn:
        return run_search(conn, literal, query, limit)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit('Usage: py workers/hybrid_search.py "your query" [limit]')
    query = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 8

    model = load_model()
    rows = search(get_conn_string(), model, query, limit)

    print(f'\nTop {len(rows)} open jobs for: "{query}"\n')
    print(f"  {'score':>7}  {'vec':>4}  {'txt':>4}  job")
    for job_id, title, score, vec_rank, txt_rank in rows:
        v = str(vec_rank) if vec_rank is not None else "-"
        t = str(txt_rank) if txt_rank is not None else "-"
        print(f"  {score:>7}  {v:>4}  {t:>4}  {job_id}  {title}")


if __name__ == "__main__":
    main()
