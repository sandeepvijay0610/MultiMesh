"""Typed settings loaded from environment / .env."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    airlock_base_url: str = "http://airlock-app:3000"
    airlock_request_timeout: float = 15.0

    mcp_host: str = "0.0.0.0"
    mcp_port: int = 8001

    # Global dry-run override. When True, every provider call is simulated
    # regardless of credentials. Set to false in compose to allow live calls
    # for non-AKIA_TEST credentials.
    dry_run: bool = True

    # Shared secret presented to Node's /credentials endpoint. Must match
    # INTERNAL_CREDENTIALS_TOKEN on the Node side.
    internal_credentials_token: str = ""

    aws_default_region: str = "us-east-1"


settings = Settings()