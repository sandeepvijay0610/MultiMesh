"""
Centralised, typed configuration. Values are read from environment variables
and, when present, a sibling ``.env`` file.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---- Airlock Node backend ----
    airlock_base_url: str = "http://airlock-app:3000"
    airlock_request_timeout: float = 15.0

    # ---- MCP microservice ----
    mcp_server_url: str = "http://mcp-service:8001"
    mcp_request_timeout: float = 30.0

    # ---- Provider selection ----
    # "auto" | "openai" | "azure" | "mock"
    llm_provider: str = "auto"

    # ---- Plain OpenAI ----
    openai_api_key: str = "sk-not-configured"
    openai_base_url: str | None = None
    llm_model: str = "gpt-4o-mini"

    # ---- Azure OpenAI / Azure AI Foundry ----
    azure_openai_api_key: str | None = None
    azure_openai_endpoint: str | None = None
    azure_openai_api_version: str = "2024-08-01-preview"
    azure_openai_deployment: str | None = None

    # ---- LLM tuning ----
    llm_temperature: float = 0.0

    # ---- Persistence ----
    sqlite_path: str = "./data/checkpoints.sqlite"

    # ---- Server ----
    host: str = "0.0.0.0"
    port: int = 8000


settings = Settings()