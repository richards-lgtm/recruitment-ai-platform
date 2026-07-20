"""Semantic search over embedded job chunks — also the pipeline's smoke test.

Embeds the query with BGE-M3 (same model as the chunks), runs cosine
similarity via the HNSW index, and prints the best-matching jobs.

Run:  py workers/semantic_search.py "solar project manager with estimating experience"
"""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
from embed_worker import get_conn_string, load_model  # noqa: E402

SEARCH_SQL = """
select j.job_id, j.title, c.source,
       round((1 - (c.embedding <=> %s::vector))::numeric, 4) as similarity
from job_chunks c
join jobs j using (job_id)
where c.embedding is not null
order by c.embedding <=> %s::vector
limit %s
"""


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit('Usage: py workers/semantic_search.py "your query" [limit]')
    query = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 8

    model = load_model()
    vec = model.encode([query])["dense_vecs"][0]
    literal = "[" + ",".join(f"{x:.7f}" for x in vec) + "]"

    with psycopg.connect(get_conn_string()) as conn, conn.cursor() as cur:
        cur.execute(SEARCH_SQL, (literal, literal, limit))
        rows = cur.fetchall()

    print(f'\nTop {len(rows)} matches for: "{query}"\n')
    for job_id, title, source, sim in rows:
        print(f"  {sim}  {job_id}  [{source}]  {title}")


if __name__ == "__main__":
    main()
