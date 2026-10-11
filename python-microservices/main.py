"""
FastAPI entrypoint.

Endpoints
---------
GET  /health                    liveness probe
POST /invoke                    start a new thread, run until interrupt
POST /resume/{thread_id}        approve/reject the pending action, continue
GET  /state/{thread_id}         inspect a thread (debugging / polling)
"""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from langchain_core.messages import BaseMessage, HumanMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command
from fastapi.middleware.cors import CORSMiddleware
from config import settings
from graph import build_graph
from schemas import (
    InvokeRequest,
    InvokeResponse,
    ResumeRequest,
    ResumeResponse,
    StateResponse,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
log = logging.getLogger("airlock.main")


# Keys whose values must never be serialized back to a caller.
_REDACTED_KEYS = {"user_token"}


# ---------------------------------------------------------------------------
# Lifespan: open the SQLite checkpointer and compile the graph once.
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the checkpoint directory exists.
    db_dir = os.path.dirname(os.path.abspath(settings.sqlite_path))
    os.makedirs(db_dir, exist_ok=True)

    log.info("Opening SQLite checkpointer at %s", settings.sqlite_path)
    async with AsyncSqliteSaver.from_conn_string(settings.sqlite_path) as cp:
        # Older versions of langgraph-checkpoint-sqlite require an explicit
        # setup() call to create the checkpoint tables. Newer versions do it
        # automatically inside from_conn_string. Calling it defensively is
        # safe — it's idempotent.
        try:
            await cp.setup()
        except Exception as exc:  # pragma: no cover
            log.debug("checkpointer.setup() skipped: %s", exc)

        app.state.checkpointer = cp
        app.state.graph = build_graph(cp)
        log.info("LangGraph compiled")
        yield

    log.info("Shutdown complete")


app = FastAPI(
    title="Airlock LangGraph Microservice",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _extract_last_text(messages: list[BaseMessage] | None) -> str | None:
    """Return the most recent non-empty text content from the transcript."""
    for msg in reversed(messages or []):
        content = getattr(msg, "content", None)

        if isinstance(content, str) and content.strip():
            return content.strip()

        # Newer OpenAI models can return content as a list of blocks.
        if isinstance(content, list):
            parts = [
                block.get("text", "")
                for block in content
                if isinstance(block, dict)
            ]
            text = " ".join(p for p in parts if p).strip()
            if text:
                return text

    return None


def _serialize_values(values: dict | None) -> dict:
    """
    Make a state snapshot JSON-safe for the /state endpoint.

    Redacts credential-bearing keys (currently ``user_token``) so the debug
    endpoint cannot be used to exfiltrate the forwarded JWT.
    """
    out: dict = {}
    for key, val in (values or {}).items():
        if key in _REDACTED_KEYS:
            out[key] = "***redacted***"
            continue

        if key == "messages":
            out[key] = [
                {
                    "type": getattr(m, "type", m.__class__.__name__),
                    "content": getattr(m, "content", ""),
                    "tool_calls": getattr(m, "tool_calls", None),
                }
                for m in val
            ]
        else:
            out[key] = val
    return out


def _get_graph(request: Request):
    graph = getattr(request.app.state, "graph", None)
    if graph is None:
        raise HTTPException(status_code=503, detail="Graph not initialised")
    return graph


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "airlock-langgraph"}


@app.post("/invoke", response_model=InvokeResponse)
async def invoke(req: InvokeRequest, request: Request) -> InvokeResponse:
    """
    Start a fresh thread. Runs the graph until it either finishes the turn
    (no tool call) or pauses inside ``human_gate`` awaiting approval.

    The supplied ``user_token`` is stored on the graph state and forwarded
    verbatim to the Node Airlock backend on every ``/api/actions/propose``
    call, satisfying its per-user Environment ownership check.
    """
    graph = _get_graph(request)
    thread_id = str(uuid.uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    initial_state = {
        "messages": [HumanMessage(content=req.prompt)],
        "environment_id": req.environment_id,
        "user_token": req.user_token,  # ← forwarded to Node as Bearer
        "pending_tool_call": None,
        "airlock_action_id": None,
        "approval_status": "PENDING",
    }

    # Log identifiers only — never the token itself.
    log.info("invoke thread=%s env=%s", thread_id, req.environment_id)

    try:
        await graph.ainvoke(initial_state, config)
    except Exception as exc:
        log.exception("Graph invocation failed")
        raise HTTPException(status_code=502, detail=f"Graph error: {exc}") from exc

    snapshot = await graph.aget_state(config)
    values = snapshot.values or {}

    return InvokeResponse(
        thread_id=thread_id,
        action_id=values.get("airlock_action_id"),
        approval_status=values.get("approval_status", "PENDING"),
        interrupted=bool(snapshot.next),
        message=_extract_last_text(values.get("messages")),
    )


@app.post("/resume/{thread_id}", response_model=ResumeResponse)
async def resume(
    thread_id: str, req: ResumeRequest, request: Request
) -> ResumeResponse:
    """
    Resume a paused thread with an approve/reject decision.

    ``Command(resume=<payload>)`` is delivered as the return value of the
    ``interrupt()`` call inside ``human_gate``.

    If the caller supplies a refreshed ``user_token``, it replaces the one in
    state — useful when the original JWT may have expired while the thread
    was paused awaiting human review.
    """
    graph = _get_graph(request)
    config = {"configurable": {"thread_id": thread_id}}

    snapshot = await graph.aget_state(config)
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="Thread not found")

    if not snapshot.next:
        raise HTTPException(
            status_code=409,
            detail="Thread is not awaiting approval",
        )

    # Optional: refresh the stored token before resuming.
    if req.user_token:
        await graph.aupdate_state(
            config,
            {"user_token": req.user_token},
        )

    log.info(
        "resume thread=%s decision=%s", thread_id, req.approval_status
    )

    try:
        await graph.ainvoke(
            Command(resume={"approval_status": req.approval_status}),
            config,
        )
    except Exception as exc:
        log.exception("Graph resume failed")
        raise HTTPException(status_code=502, detail=f"Graph error: {exc}") from exc

    # The resumed run may itself end at another interrupt (e.g. the LLM
    # proposed a second tool call), or it may have run to completion.
    snapshot = await graph.aget_state(config)
    values = snapshot.values or {}

    return ResumeResponse(
        thread_id=thread_id,
        approval_status=values.get("approval_status", req.approval_status),
        airlock_action_id=values.get("airlock_action_id"),
        interrupted=bool(snapshot.next),
        message=_extract_last_text(values.get("messages")),
    )


@app.get("/state/{thread_id}", response_model=StateResponse)
async def get_thread_state(thread_id: str, request: Request) -> StateResponse:
    """Inspect the current state of a thread (useful for polling / debugging)."""
    graph = _get_graph(request)
    config = {"configurable": {"thread_id": thread_id}}

    snapshot = await graph.aget_state(config)
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="Thread not found")

    return StateResponse(
        thread_id=thread_id,
        values=_serialize_values(snapshot.values),
        next=list(snapshot.next or []),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )