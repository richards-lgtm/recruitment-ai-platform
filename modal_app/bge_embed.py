# BGE-M3 embedding service on Modal — GPU-hosted drop-in for the local
# chatbot/api/embed_service.py (same contract: POST /embed, GET /health).
#
# Deploy:   py -m modal deploy modal_app/bge_embed.py
# Consume:  set in .env —
#   EMBED_SERVICE_URL=https://vdart-ai-resume--bge-embed-embedder-api.modal.run
#   EMBED_SERVICE_TOKEN=<value of the embed-api-key Modal secret>
# workers/embed_worker.load_model() and the chatbot API both honor these, so
# the chat CLI, hybrid search, the batch embed worker, and the web API all
# switch to remote embedding with no code changes.
#
# Why: CPU embedding on the laptop is the chatbot's dominant latency
# (2-6s/query measured 2026-07-17); a T4 does it in tens of milliseconds.
# Same scale-to-zero cost model as the qwen-vllm app.
#
# Governance: unlike the local embed service, query/chunk text (already
# PII-masked) leaves the network for embedding — dev/testing only, same rule
# as the Modal LLM and Supabase dev DB. IMPORTANT: embeddings from this
# service and from local BGE-M3 are the same model, so vectors stay
# compatible with the existing job_chunks embeddings either way.

import modal

MINUTES = 60

image = (
    modal.Image.debian_slim(python_version="3.12")
    # FlagEmbedding 1.4.0 + transformers 5.x is the combo proven on the laptop;
    # 1.3.x crash-loops (imports removed transformers internals).
    .pip_install("FlagEmbedding==1.4.0", "transformers==5.13.1", "fastapi[standard]==0.115.12")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

hf_cache_vol = modal.Volume.from_name("huggingface-cache", create_if_missing=True)

app = modal.App("bge-embed")


@app.cls(
    image=image,
    gpu="T4",  # ~$0.59/hr while running; BGE-M3 is small, T4 is plenty
    scaledown_window=5 * MINUTES,
    timeout=10 * MINUTES,
    volumes={"/root/.cache/huggingface": hf_cache_vol},
    # Created with: py -m modal secret create embed-api-key EMBED_API_KEY=<key>
    secrets=[modal.Secret.from_name("embed-api-key")],
)
@modal.concurrent(max_inputs=8)
class Embedder:
    @modal.enter()
    def load(self):
        import threading

        from FlagEmbedding import BGEM3FlagModel

        self.model = BGEM3FlagModel("BAAI/bge-m3", use_fp16=True)  # fp16 on GPU
        self.lock = threading.Lock()  # BGE-M3 encode isn't thread-safe

    @modal.asgi_app()
    def api(self):
        import os

        from fastapi import Depends, FastAPI, HTTPException, Request
        from pydantic import BaseModel, Field

        expected = f"Bearer {os.environ['EMBED_API_KEY']}"

        def require_key(request: Request) -> None:
            if request.headers.get("authorization") != expected:
                raise HTTPException(status_code=401, detail="missing or bad API key")

        web = FastAPI(title="BGE-M3 embedding service (Modal)")

        class EmbedRequest(BaseModel):
            texts: list[str] = Field(min_length=1, max_length=64)

        @web.get("/health", dependencies=[Depends(require_key)])
        def health() -> dict:
            return {"status": "ok", "model": "BAAI/bge-m3", "where": "modal-t4"}

        @web.post("/embed", dependencies=[Depends(require_key)])
        def embed(req: EmbedRequest) -> dict:
            with self.lock:
                vectors = self.model.encode(req.texts)["dense_vecs"]
            return {"vectors": [[float(x) for x in v] for v in vectors]}

        return web
