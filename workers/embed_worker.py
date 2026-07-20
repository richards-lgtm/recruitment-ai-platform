"""Embedding worker (2026-07-15 architecture): fills NULL embedding columns in
job_chunks with BGE-M3 dense vectors (1024 dims).

By default the model runs locally (CPU is fine) so chunk text never leaves the
machine for embedding — the only network traffic is the SQL to the database.
First run downloads the model (~2.2 GB) from Hugging Face into the local cache.

If EMBED_SERVICE_URL is set (with EMBED_SERVICE_TOKEN for the Modal
deployment — modal_app/bge_embed.py), load_model() returns a RemoteEmbedder
instead and every caller (this worker, chat.py, hybrid_search.py, the chatbot
API) embeds via that service. Same BGE-M3 model either way, so vectors stay
compatible with existing job_chunks rows. Governance: the remote path sends
(masked) text off-network — dev/testing only, same rule as the Modal LLM.

Run:  py workers/embed_worker.py            # embed all pending chunks
      py workers/embed_worker.py --loop     # keep polling every 60s (daemon mode)

Reads DATABASE_URL from the project .env (same variable the scraper uses).
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import psycopg
from dotenv import load_dotenv

BATCH_SIZE = 16  # chunks per model call — keeps CPU memory modest


def get_conn_string() -> str:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set (expected in the project .env).")
    return url


class RemoteEmbedder:
    """model.encode-compatible client for an embedding service (local
    chatbot/api/embed_service.py or the Modal deployment), so callers work
    identically whether BGE-M3 is in-process or remote."""

    def __init__(self, base_url: str, token: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    def encode(self, texts, **_) -> dict:
        import httpx  # bundled with the openai package's deps

        # Generous timeout: a scaled-to-zero Modal container cold-starts on
        # the first request (GPU boot + model load can take a minute or two).
        # follow_redirects: past ~150s Modal answers with a 303 + attempt-token
        # URL that must be followed to collect the pending result.
        resp = httpx.post(
            f"{self.base_url}/embed", json={"texts": list(texts)},
            headers=self.headers, timeout=300, follow_redirects=True,
        )
        resp.raise_for_status()
        return {"dense_vecs": resp.json()["vectors"]}


def load_local_model():
    """Always load BGE-M3 in-process — what embed_service.py itself serves."""
    # Import here so `--help` stays instant.
    from FlagEmbedding import BGEM3FlagModel

    print("Loading BGE-M3 (first run downloads ~2.2 GB)...", flush=True)
    return BGEM3FlagModel("BAAI/bge-m3", use_fp16=False)  # fp32 on CPU


def load_model():
    """In-process BGE-M3, or a RemoteEmbedder when EMBED_SERVICE_URL is set.
    Loads .env first — some callers (this worker's main) reach here before
    get_conn_string() has done it."""
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    service_url = os.environ.get("EMBED_SERVICE_URL")
    if service_url:
        print(f"Embedding via service at {service_url}", flush=True)
        return RemoteEmbedder(service_url, os.environ.get("EMBED_SERVICE_TOKEN"))
    return load_local_model()


def embed_pending(conn_string: str, model) -> int:
    """Embed every chunk with a NULL embedding. Returns how many were filled.

    CPU inference on a batch can take minutes, and Supabase's pooler kills
    connections that sit idle that long — so never hold a connection across a
    model.encode() call: one short-lived connection to fetch, another to write.
    """
    done = 0
    while True:
        with psycopg.connect(conn_string) as conn:
            rows = conn.execute(
                "select id, content from job_chunks where embedding is null"
                " order by id limit %s",
                (BATCH_SIZE,),
            ).fetchall()
        if not rows:
            return done

        texts = [content for _, content in rows]
        vectors = model.encode(texts, batch_size=BATCH_SIZE)["dense_vecs"]

        with psycopg.connect(conn_string) as conn:
            with conn.cursor() as cur:
                for (chunk_id, _), vec in zip(rows, vectors):
                    literal = "[" + ",".join(f"{x:.7f}" for x in vec) + "]"
                    cur.execute(
                        "update job_chunks set embedding = %s::vector where id = %s",
                        (literal, chunk_id),
                    )
            conn.commit()
        done += len(rows)
        print(f"  embedded {done} chunk(s) so far...", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--loop", action="store_true",
        help="poll for new pending chunks every 60s instead of exiting",
    )
    args = parser.parse_args()

    model = load_model()
    conn_string = get_conn_string()
    while True:
        n = embed_pending(conn_string, model)
        print(f"Done: {n} chunk(s) embedded this pass.", flush=True)
        if not args.loop:
            break
        time.sleep(60)


if __name__ == "__main__":
    main()
