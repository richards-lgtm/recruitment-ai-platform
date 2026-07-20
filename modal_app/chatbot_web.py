# Chatbot web app (API + frontend) on Modal — hosts chatbot/api/server.py and
# the static frontend at a public URL, completing the all-on-Modal dev stack:
#
#   browser → chatbot-web (this app, CPU) → bge-embed (T4)   [query embedding]
#                                        → qwen-vllm (L40S)  [generation]
#                                        → Supabase          [hybrid search]
#
# Deploy:   py -m modal deploy modal_app/chatbot_web.py
# URL:      https://vdart-ai-resume--chat.modal.run
#           (short label set via @modal.asgi_app(label="chat"); the
#           vdart-ai-resume-- workspace prefix is fixed on *.modal.run)
#
# Config comes from the Modal secret `chatbot-env` (NOT the local .env):
#   DATABASE_URL, LLM_BASE_URL, LLM_MODEL, LLM_API_KEY,
#   EMBED_SERVICE_URL, EMBED_SERVICE_TOKEN,
#   CHATBOT_API_TOKEN   <- REQUIRED here: the URL is public, so the API must
#                          demand a bearer token (frontend prompts once and
#                          stores it in localStorage)
#   CHATBOT_ALLOWED_ORIGINS
# Update with: py -m modal secret create chatbot-env KEY=value ... --force
#
# The server code is unchanged — server.py resolves everything relative to its
# own location, so mirroring the repo layout under /app (workers/, chatbot/)
# makes ROOT-relative imports and the frontend mount work exactly as locally.
# No GPU here: embedding is a remote call (EMBED_SERVICE_URL), so this stays a
# cheap CPU container with fast cold starts.
#
# Governance: same dev-only footing as the rest of the Modal stack — masked
# job data behind a token on a public URL, manager sign-off still pending.

from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent

MINUTES = 60

image = (
    modal.Image.debian_slim(python_version="3.12")
    # Latest stable releases; nothing here has the FlagEmbedding-style
    # compat trap (FlagEmbedding itself is never imported on this path).
    .pip_install(
        "fastapi[standard]",
        "uvicorn",
        "psycopg[binary,pool]",
        "httpx",
        "openai",
        "python-dotenv",
    )
    # Mirror the repo layout under /app so server.py's ROOT logic holds.
    .add_local_dir(ROOT / "workers", "/app/workers", ignore=["**/__pycache__"])
    .add_local_dir(ROOT / "chatbot", "/app/chatbot", ignore=["**/__pycache__"])
)

app = modal.App("chatbot")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("chatbot-env")],
    scaledown_window=10 * MINUTES,
    timeout=10 * MINUTES,
)
@modal.concurrent(max_inputs=100)  # I/O-bound: DB + HTTP calls, no model
@modal.asgi_app(label="chat")
def web():
    import sys

    sys.path.insert(0, "/app/chatbot/api")
    from server import app as fastapi_app  # lifespan opens the DB pool

    return fastapi_app
