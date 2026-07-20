# Qwen on Modal behind vLLM — OpenAI-compatible replacement for the Groq dev LLM.
#
# Deploy:   py -m modal deploy modal_app/qwen_vllm.py
# Endpoint: https://vdart-ai-resume--qwen-vllm-serve.modal.run/v1  (printed on deploy)
# The chatbot consumes it purely via env (.env):
#   LLM_BASE_URL=<endpoint>/v1
#   LLM_MODEL=qwen2.5-7b-instruct        (the --served-model-name below)
#   LLM_API_KEY=<value of the vllm-api-key Modal secret>
#
# Cost model: the container scales to ZERO after SCALEDOWN_WINDOW idle seconds,
# so credits are only spent while questions are being asked (plus cold starts).
# First request after idle takes minutes (GPU boot + model load); subsequent
# requests are fast. Volumes cache the HF download and vLLM compile artifacts
# so cold starts get cheaper after the first one.
#
# Governance: same rule as Groq — prompts carry masked job text off-network,
# dev/testing only until manager sign-off. The endpoint is public HTTPS but
# rejects requests without the API key (vLLM --api-key from the Modal secret).

import modal

# Qwen2.5-7B-Instruct: non-reasoning, so it behaves with the chatbot's small
# max_tokens condense calls (a thinking-mode Qwen3 would spend the whole budget
# on <think> tokens). Ungated on HF — no HF token needed. To upgrade, change
# MODEL_NAME (+ SERVED_NAME and .env LLM_MODEL) and redeploy; e.g.
# "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8" also fits the L40S but needs a newer
# vLLM pin.
MODEL_NAME = "Qwen/Qwen2.5-7B-Instruct"
SERVED_NAME = "qwen2.5-7b-instruct"  # what LLM_MODEL must be set to

GPU = "L40S"  # 48 GB, ~$1.95/hr while running; "A10G" (~$1.10/hr) also fits, slower
MAX_MODEL_LEN = 16384  # chatbot prompts run ~6.5k tokens; 16k leaves headroom
VLLM_PORT = 8000
MINUTES = 60
SCALEDOWN_WINDOW = 15 * MINUTES  # idle before the GPU stops billing; 15 min so
# repeated use within a work session stays warm (avoids re-paying the cold start
# for each /boolean or question), at the cost of a longer idle tail after use.

# Pins from Modal's vLLM reference example — known-good combination for CUDA 12.8.
vllm_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "vllm==0.9.1",
        "huggingface_hub[hf_transfer]==0.32.0",
        "flashinfer-python==0.2.6.post1",
        extra_index_url="https://download.pytorch.org/whl/cu128",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})  # fast model download on first boot
)

# Persistent caches so cold starts after the first don't re-download (~15 GB)
# or re-compile.
hf_cache_vol = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
vllm_cache_vol = modal.Volume.from_name("vllm-cache", create_if_missing=True)

app = modal.App("qwen-vllm")


@app.function(
    image=vllm_image,
    gpu=GPU,
    scaledown_window=SCALEDOWN_WINDOW,
    timeout=10 * MINUTES,
    volumes={
        "/root/.cache/huggingface": hf_cache_vol,
        "/root/.cache/vllm": vllm_cache_vol,
    },
    # Created with: py -m modal secret create vllm-api-key VLLM_API_KEY=<key>
    secrets=[modal.Secret.from_name("vllm-api-key")],
)
@modal.concurrent(max_inputs=32)  # one replica batches concurrent requests (vLLM's job)
@modal.web_server(port=VLLM_PORT, startup_timeout=10 * MINUTES)
def serve():
    import os
    import subprocess

    cmd = [
        "vllm", "serve", MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(VLLM_PORT),
        "--served-model-name", SERVED_NAME,
        "--max-model-len", str(MAX_MODEL_LEN),
        "--api-key", os.environ["VLLM_API_KEY"],  # reject unauthenticated callers
    ]
    subprocess.Popen(cmd)
