"""
MCP server for the Airlock multi-cloud operations platform.

Endpoints:
  GET  /health                    health probe
  GET  /resources                 read-only inventory for the UI
  POST /tools/{name}              REST tool dispatcher
  GET  /sse + POST /messages/     MCP-over-SSE
"""

from __future__ import annotations

import contextvars
import logging

from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from config import settings
from providers import CloudCredentials, ProviderFactory
from vault_client import VaultClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
log = logging.getLogger("airlock.mcp.server")


_current_context: contextvars.ContextVar[dict[str, str]] = contextvars.ContextVar(
    "mcp_request_context", default={}
)


class ContextMiddleware:
    """Reads per-request headers into a contextvar for tool dispatch."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        raw = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        env_id = raw.get("x-environment-id", "")
        auth = raw.get("authorization", "")
        user_token = ""
        if auth.lower().startswith("bearer "):
            user_token = auth[7:].strip()

        token = _current_context.set(
            {"environment_id": env_id, "user_token": user_token}
        )
        try:
            await self.app(scope, receive, send)
        finally:
            _current_context.reset(token)


mcp = FastMCP("airlock-cloud-ops")

vault = VaultClient(
    base_url=settings.airlock_base_url,
    timeout=settings.airlock_request_timeout,
)


# ---------------------------------------------------------------------------
# Provider resolution helper — shared by REST endpoints
# ---------------------------------------------------------------------------
async def _resolve_provider(ctx: dict):
    """
    Resolve a provider instance from the request context.
    Returns (provider, None) on success or (None, error_message).
    """
    environment_id = ctx.get("environment_id", "")
    user_token = ctx.get("user_token", "")

    if not environment_id or not user_token:
        return None, "missing environment_id or user_token in request context"

    try:
        bundle = vault.fetch_credentials(environment_id, user_token)
    except Exception as exc:
        log.exception("vault fetch failed")
        return None, f"vault fetch failed: {exc}"

    provider_name = bundle.provider or "AWS"
    try:
        provider = ProviderFactory.create(
            provider_name,
            bundle.credentials,
            dry_run=settings.dry_run,
        )
    except ValueError as exc:
        return None, str(exc)

    return provider, None


async def _dispatch_tool(name: str, arguments: dict, ctx: dict) -> dict:
    provider, err = await _resolve_provider(ctx)
    if err:
        return {"error": err}

    log.info(
        "dispatch tool=%s provider=%s dry_run=%s env=%s",
        name,
        provider.provider_name,
        settings.dry_run or provider.credentials is None,
        ctx.get("environment_id"),
    )

    try:
        if name == "start_ec2_instance":
            return provider.start_compute_instance(**arguments)
        if name == "stop_ec2_instance":
            return provider.stop_compute_instance(**arguments)
        if name == "reboot_ec2_instance":
            return provider.reboot_compute_instance(**arguments)
        if name == "terminate_ec2_instance":
            return provider.terminate_compute_instance(**arguments)
        if name == "create_ec2_instance":
            return provider.create_compute_instance(**arguments)
        if name == "restart_rds_instance":
            return provider.reboot_database(**arguments)
        if name == "start_rds_instance":
            return provider.start_database(**arguments)
        if name == "stop_rds_instance":
            return provider.stop_database(**arguments)
        if name == "create_s3_bucket":
            return provider.create_bucket(**arguments)
        if name == "delete_s3_bucket":
            return provider.delete_bucket(**arguments)
        if name == "invoke_lambda_function":
            return provider.invoke_function(**arguments)
        if name == "scale_gke_node_pool":
            return provider.scale_cluster(**arguments)
        return {"error": f"unknown tool: {name}"}
    except Exception as exc:
        log.exception("provider execution failed for tool=%s", name)
        return {"error": str(exc), "tool": name}


# ---------------------------------------------------------------------------
# @mcp.tool() declarations — the LLM-visible surface
# ---------------------------------------------------------------------------

@mcp.tool()
async def start_ec2_instance(instance_id: str) -> dict:
    """Start an AWS EC2 instance. Args: instance_id (e.g. "i-0abc...")."""
    return await _dispatch_tool(
        "start_ec2_instance", {"instance_id": instance_id}, _current_context.get()
    )


@mcp.tool()
async def stop_ec2_instance(instance_id: str) -> dict:
    """Stop a running AWS EC2 instance. Args: instance_id."""
    return await _dispatch_tool(
        "stop_ec2_instance", {"instance_id": instance_id}, _current_context.get()
    )


@mcp.tool()
async def reboot_ec2_instance(instance_id: str) -> dict:
    """Reboot a running AWS EC2 instance. Args: instance_id."""
    return await _dispatch_tool(
        "reboot_ec2_instance", {"instance_id": instance_id}, _current_context.get()
    )


@mcp.tool()
async def terminate_ec2_instance(instance_id: str) -> dict:
    """Terminate (permanently destroy) an AWS EC2 instance. Args: instance_id."""
    return await _dispatch_tool(
        "terminate_ec2_instance", {"instance_id": instance_id}, _current_context.get()
    )


@mcp.tool()
async def create_ec2_instance(name: str = "airlock-node", instance_type: str = "t3.micro") -> dict:
    """Create a new Amazon Linux 2023 EC2 instance. Args: name, instance_type."""
    return await _dispatch_tool(
        "create_ec2_instance",
        {"name": name, "instance_type": instance_type},
        _current_context.get(),
    )


@mcp.tool()
async def restart_rds_instance(db_instance_identifier: str) -> dict:
    """Reboot an AWS RDS database instance. Args: db_instance_identifier."""
    return await _dispatch_tool(
        "restart_rds_instance",
        {"db_instance_identifier": db_instance_identifier},
        _current_context.get(),
    )


@mcp.tool()
async def start_rds_instance(db_instance_identifier: str) -> dict:
    """Start a stopped AWS RDS instance. Args: db_instance_identifier."""
    return await _dispatch_tool(
        "start_rds_instance",
        {"db_instance_identifier": db_instance_identifier},
        _current_context.get(),
    )


@mcp.tool()
async def stop_rds_instance(db_instance_identifier: str) -> dict:
    """Stop a running AWS RDS instance. Args: db_instance_identifier."""
    return await _dispatch_tool(
        "stop_rds_instance",
        {"db_instance_identifier": db_instance_identifier},
        _current_context.get(),
    )


@mcp.tool()
async def create_s3_bucket(bucket_name: str) -> dict:
    """Create a new S3 bucket in the environment's region. Args: bucket_name."""
    return await _dispatch_tool(
        "create_s3_bucket", {"bucket_name": bucket_name}, _current_context.get()
    )


@mcp.tool()
async def delete_s3_bucket(bucket_name: str) -> dict:
    """Delete an empty S3 bucket. Args: bucket_name."""
    return await _dispatch_tool(
        "delete_s3_bucket", {"bucket_name": bucket_name}, _current_context.get()
    )


@mcp.tool()
async def invoke_lambda_function(function_name: str, payload_json: str = "{}") -> dict:
    """Synchronously invoke an AWS Lambda function. Args: function_name, payload_json."""
    return await _dispatch_tool(
        "invoke_lambda_function",
        {"function_name": function_name, "payload_json": payload_json},
        _current_context.get(),
    )


@mcp.tool()
async def scale_gke_node_pool(cluster_id: str, node_pool_id: str, node_count: int) -> dict:
    """Resize a GKE node pool. Args: cluster_id, node_pool_id, node_count."""
    return await _dispatch_tool(
        "scale_gke_node_pool",
        {
            "cluster_id": cluster_id,
            "node_pool_id": node_pool_id,
            "node_count": node_count,
        },
        _current_context.get(),
    )


# ---------------------------------------------------------------------------
# REST handlers
# ---------------------------------------------------------------------------
async def rest_tool(request):
    name = request.path_params["name"]
    try:
        arguments = await request.json()
    except Exception:
        arguments = {}
    return JSONResponse(await _dispatch_tool(name, arguments, _current_context.get()))


async def rest_resources(request):
    """Read-only inventory — no HITL, no LLM involvement."""
    ctx = _current_context.get()
    provider, err = await _resolve_provider(ctx)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    try:
        return JSONResponse(provider.list_resources())
    except Exception as exc:
        log.exception("list_resources failed")
        return JSONResponse({"error": str(exc)}, status_code=500)


async def health(request):
    return JSONResponse(
        {
            "status": "ok",
            "service": "airlock-mcp",
            "providers": ProviderFactory.registered(),
            "dry_run": settings.dry_run,
        }
    )


# ---------------------------------------------------------------------------
# ASGI assembly
# ---------------------------------------------------------------------------
sse_app = mcp.sse_app()

starlette_app = Starlette(
    routes=[
        Route("/health", health, methods=["GET"]),
        Route("/resources", rest_resources, methods=["GET"]),
        Route("/tools/{name}", rest_tool, methods=["POST"]),
        Mount("/", app=sse_app),
    ]
)

starlette_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app = ContextMiddleware(starlette_app)


if __name__ == "__main__":
    import uvicorn

    log.info(
        "Starting MCP server on %s:%d (providers=%s, dry_run=%s)",
        settings.mcp_host,
        settings.mcp_port,
        ProviderFactory.registered(),
        settings.dry_run,
    )
    uvicorn.run(
        "server:app",
        host=settings.mcp_host,
        port=settings.mcp_port,
        log_level="info",
    )