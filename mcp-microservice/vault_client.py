"""
VaultClient — Just-in-time credential hand-off from the Node Airlock.

Endpoint strategy:
  1. GET /api/environments/{id}/credentials  (returns decrypted creds;
                                              requires X-Internal-Token
                                              when configured on Node)
  2. GET /api/environments/{id}              (metadata-only fallback so
                                              dry-run keeps working)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from config import settings
from providers.base import CloudCredentials

log = logging.getLogger("airlock.mcp.vault")


@dataclass
class CredentialBundle:
    provider: str | None
    credentials: CloudCredentials | None


class VaultClient:
    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.internal_token = (settings.internal_credentials_token or "").strip()

    def _headers(self, user_token: str) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {user_token}",
        }
        if self.internal_token:
            headers["X-Internal-Token"] = self.internal_token
        return headers

    def fetch_credentials(
        self, environment_id: str, user_token: str
    ) -> CredentialBundle:
        creds_url = f"{self.base_url}/api/environments/{environment_id}/credentials"
        meta_url = f"{self.base_url}/api/environments/{environment_id}"

        with httpx.Client(timeout=self.timeout) as client:
            # ---- 1. Credentials endpoint ------------------------------------
            try:
                resp = client.get(creds_url, headers=self._headers(user_token))

                if resp.status_code == 200:
                    data = resp.json() or {}
                    ak = data.get("accessKey")
                    sk = data.get("secretKey")
                    provider = data.get("provider")
                    if ak and sk:
                        log.info(
                            "vault: live credentials env=%s provider=%s",
                            environment_id, provider,
                        )
                        return CredentialBundle(
                            provider=provider,
                            credentials=CloudCredentials(access_key=ak, secret_key=sk),
                        )
                    log.info("vault: /credentials no keys env=%s", environment_id)

                elif resp.status_code == 403:
                    # Cross-tenant attempt or bad internal token — propagate.
                    detail = "forbidden"
                    try:
                        detail = (resp.json() or {}).get("error", detail)
                    except Exception:
                        pass
                    raise RuntimeError(
                        f"VaultClient: /credentials rejected (403): {detail}"
                    )

                elif resp.status_code not in (404, 405):
                    log.warning(
                        "vault: /credentials unexpected %s env=%s",
                        resp.status_code, environment_id,
                    )
            except httpx.HTTPError as exc:
                log.warning("vault: /credentials transport error: %s", exc)

            # ---- 2. Metadata-only fallback ---------------------------------
            resp = client.get(meta_url, headers=self._headers(user_token))
            resp.raise_for_status()
            body = resp.json() or {}
            env = body.get("environment") or body
            provider = env.get("provider")

            log.info(
                "vault: metadata-only env=%s provider=%s (dry-run)",
                environment_id, provider,
            )
            return CredentialBundle(provider=provider, credentials=None)