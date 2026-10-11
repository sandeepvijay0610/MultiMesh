"""
Thin HTTP client for the MCP microservice's REST endpoints.

The LLM never sees environment_id or user_token — they travel in headers.
The MCP server pulls credentials from Node.js just-in-time and executes
the operation. Nothing credential-bearing touches the graph state.
"""

from __future__ import annotations

import logging

import httpx

from config import settings

log = logging.getLogger("airlock.mcp_client")


class MCPClient:
    def __init__(self, base_url: str | None = None, timeout: float | None = None):
        self.base_url = (base_url or settings.mcp_server_url).rstrip("/")
        self.timeout = timeout if timeout is not None else settings.mcp_request_timeout

    def call_tool(
        self,
        name: str,
        arguments: dict,
        environment_id: str,
        user_token: str,
    ) -> dict:
        """
        POST {base}/tools/{name} with domain args in the body and
        environment_id + user_token in headers. Returns the parsed JSON
        response. Raises RuntimeError on non-2xx.
        """
        url = f"{self.base_url}/tools/{name}"
        headers = {
            "Content-Type": "application/json",
            "X-Environment-Id": environment_id,
            "Authorization": f"Bearer {user_token}",
        }

        log.info("MCP call -> POST %s", url)

        with httpx.Client(timeout=self.timeout) as client:
            resp = client.post(url, headers=headers, json=arguments)

            if resp.status_code >= 400:
                try:
                    detail = resp.json().get("error", resp.text)
                except Exception:
                    detail = resp.text
                raise RuntimeError(
                    f"MCP server error ({resp.status_code}): {detail}"
                )

            return resp.json()