"""BGE-M3 embedding microservice — decouples the model from the web API.

Why this exists: the chat API is otherwise stateless, but an in-process
BGE-M3 pins 2 GB of memory per worker, so the API can't scale horizontally.
Run ONE of these, point the API at it (EMBED_SERVICE_URL=http://localhost:8100),
and run as many API workers as you like (CHATBOT_WORKERS=4).

The model stays local (this service runs on the same machine/network), so the
"no data leaves the network for embedding" rule holds.

Run:  py chatbot/api/embed_service.py            # port 8100 (EMBED_PORT to change)
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workers"))
# load_local_model, not load_model: this service IS the embedding backend, so
# it must never follow EMBED_SERVICE_URL (it would proxy to itself/Modal).
from embed_worker import load_local_model  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("embed-service")

state: dict = {}
model_lock = threading.Lock()  # serialize encodes — BGE-M3 isn't thread-safe


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["model"] = load_local_model()
    log.info("embedding service ready on port %s", os.environ.get("EMBED_PORT", "8100"))
    yield


app = FastAPI(title="BGE-M3 embedding service", lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": "BAAI/bge-m3"}


@app.post("/embed")
def embed(req: EmbedRequest) -> dict:
    with model_lock:
        vectors = state["model"].encode(req.texts)["dense_vecs"]
    return {"vectors": [[float(x) for x in v] for v in vectors]}


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("EMBED_HOST", "127.0.0.1"),
        port=int(os.environ.get("EMBED_PORT", "8100")),
    )
