# Shared image for the chatbot API and the embedding service.
# NOT YET TESTED (no Docker on the dev laptop) — first real run is on VDHY045;
# expect to iterate. Build from the repo root:
#   docker build -f chatbot/Dockerfile -t recruitment-chatbot .
FROM python:3.12-slim

WORKDIR /app

# Torch (pulled in by FlagEmbedding) is the heavyweight layer — keep the
# dependency install cached separately from code changes.
COPY workers/requirements.txt workers/requirements.txt
COPY chatbot/api/requirements.txt chatbot/api/requirements.txt
RUN pip install --no-cache-dir -r workers/requirements.txt -r chatbot/api/requirements.txt

COPY workers/ workers/
COPY chatbot/ chatbot/
COPY db/ db/

ENV PYTHONUNBUFFERED=1
# The BGE-M3 download (~2.2 GB) goes here — mount a volume to persist it.
ENV HF_HOME=/models

# Default command runs the API; compose overrides this for the embed service.
CMD ["python", "chatbot/api/server.py"]
