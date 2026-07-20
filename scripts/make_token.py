"""Generate a per-person chatbot access token from a VDart email address.

The token is '<email>:<signature>' where the signature is HMAC-SHA256 of the
lowercased email under TOKEN_SIGNING_SECRET (first 40 hex chars). The server
(chatbot/api/server.py valid_email_token) recomputes it, so there is no token
database — anyone's token can be generated here and handed to them once.

Revoking one person is not possible without a denylist; rotating
TOKEN_SIGNING_SECRET (here AND in the Modal `chatbot-env` secret) invalidates
every token at once.

Run:  py scripts/make_token.py someone@vdartinc.com
      (reads TOKEN_SIGNING_SECRET from the project .env)
"""

from __future__ import annotations

import hmac
import os
import sys
from pathlib import Path

from dotenv import load_dotenv


def make_token(secret: str, email: str) -> str:
    email = email.strip().lower()
    sig = hmac.new(secret.encode(), email.encode(), "sha256").hexdigest()[:40]
    return f"{email}:{sig}"


def main() -> None:
    if len(sys.argv) != 2 or "@" not in sys.argv[1]:
        sys.exit("Usage: py scripts/make_token.py <email@vdartinc.com>")
    email = sys.argv[1].strip().lower()

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    secret = os.environ.get("TOKEN_SIGNING_SECRET")
    if not secret:
        sys.exit("TOKEN_SIGNING_SECRET is not set (expected in the project .env).")

    domain = os.environ.get("ALLOWED_EMAIL_DOMAIN", "vdartinc.com")
    if not email.endswith(f"@{domain}"):
        sys.exit(f"Refusing: the chatbot only accepts @{domain} tokens.")

    print(make_token(secret, email))


if __name__ == "__main__":
    main()
