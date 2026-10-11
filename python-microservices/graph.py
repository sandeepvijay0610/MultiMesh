"""
The LangGraph state machine.

    START
      │
      ▼
  llm_reasoner ──(no tool call)──► END
      │
      │ (tool call emitted)
      ▼
  propose_action   ← POSTs to /api/actions/propose on the Node Airlock backend
      │              using the END USER'S JWT (state["user_token"])
      ▼
  human_gate       ← interrupt() — graph pauses, FastAPI returns
      │              On resume: POSTs the decision back to Node
      │              (approve/reject), which fires the tenant-scoped
      │              `actionStateChanged` socket event.
      ▼
  ┌───┴────┐
  │        │
  ▼        ▼
execute_tool   handle_rejection
  │        │
  └───┬────┘
      ▼
  llm_reasoner (loops back)
"""

from __future__ import annotations

import logging
import re

import httpx
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_openai import AzureChatOpenAI, ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from config import settings
from state import AgentState
from tools import TOOLS, TOOL_REGISTRY
import json
log = logging.getLogger("airlock.graph")


SYSTEM_PROMPT = """You are Airlock Copilot, an SRE assistant for a multi-cloud \
AI operations platform.

You can either:
  1. Reply directly to the user in plain language, OR
  2. Propose a tool call to execute an infrastructure operation.

Rules:
- Only propose a tool when the user has clearly asked for a concrete
  infrastructure change.
- Never invent resource identifiers; ask a clarifying question first if any
  required parameter is missing.
- Every proposed tool call will be shown to a human operator for approval
  before it runs. Keep proposals minimal and unambiguous.
- DESTRUCTIVE ACTIONS: `terminate_ec2_instance` and `delete_s3_bucket`
  permanently destroy infrastructure. Only propose them when the user has
  explicitly and unambiguously asked to do so. If the user is vague, ask
  for confirmation before proposing the tool call.
- CREATE_EC2_INSTANCE ADVISORY: When the user asks to create a new EC2
  instance, propose `create_ec2_instance` so the operator can approve or
  reject it through the Airlock gate, and include a brief note in your
  reply that AWS Console or Terraform/IaC is recommended for production
  provisioning (custom VPC, Security Groups, KeyPairs).
- After an action has been executed or rejected, summarise the outcome to
  the user in one short paragraph.
"""


# ---------------------------------------------------------------------------
# Offline mock — deterministic, no network.
# ---------------------------------------------------------------------------
class MockToolCallingLLM:
    """
    Deterministic stub used when no real LLM credentials are configured, or
    when LLM_PROVIDER=mock. Emits a genuine tool_call when the prompt asks to
    stop an EC2 instance.
    """

    def __init__(self) -> None:
        self._tools = TOOLS

    def bind_tools(self, tools):  # noqa: D401 - chainable
        self._tools = tools
        return self

    def invoke(self, messages: list[BaseMessage], **_: object) -> AIMessage:
        last_human = next(
            (m for m in reversed(messages) if isinstance(m, HumanMessage)),
            None,
        )
        text = ""
        if last_human is not None:
            c = last_human.content
            text = c if isinstance(c, str) else str(c)
        low = text.lower()

        tail = messages[-2:]
        already_handled = (
            any(isinstance(m, SystemMessage) for m in tail)
            and any(isinstance(m, ToolMessage) for m in tail)
        )

        m = re.search(r"\bi-[0-9a-f]{8,}\b", text, re.IGNORECASE)
        wants_stop = "stop" in low and "ec2" in low

        if wants_stop and m and not already_handled:
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "stop_ec2_instance",
                        "args": {"instance_id": m.group(0)},
                        "id": "call_mock_stop_ec2",
                    }
                ],
            )

        if already_handled:
            return AIMessage(
                content="Acknowledged — the requested infrastructure change "
                        "has been processed."
            )

        return AIMessage(
            content=(
                "I'm the Airlock Copilot. I can propose infrastructure "
                "actions (for example: 'Stop EC2 instance i-0abc1234def567890') "
                "which you'll be asked to approve before they run."
            )
        )


# ---------------------------------------------------------------------------
# Provider selection
# ---------------------------------------------------------------------------
def _resolve_provider() -> str:
    """Return one of: 'mock', 'azure', 'openai'."""
    p = (settings.llm_provider or "auto").strip().lower()

    if p == "mock":
        return "mock"
    if p == "azure":
        return "azure"
    if p == "openai":
        return "openai"

    # auto
    if settings.azure_openai_api_key and settings.azure_openai_endpoint:
        return "azure"

    key = (settings.openai_api_key or "").strip()
    if key and not key.startswith("sk-not") and key != "sk-replace-me":
        return "openai"

    return "mock"


def _build_azure_llm():
    """Build an Azure chat client (Azure OpenAI or Azure AI Foundry)."""
    endpoint   = (settings.azure_openai_endpoint or "").rstrip("/")
    deployment = settings.azure_openai_deployment
    api_version = settings.azure_openai_api_version
    api_key    = settings.azure_openai_api_key

    missing = [
        name
        for name, val in [
            ("AZURE_OPENAI_ENDPOINT",   endpoint),
            ("AZURE_OPENAI_DEPLOYMENT", deployment),
            ("AZURE_OPENAI_API_VERSION", api_version),
            ("AZURE_OPENAI_API_KEY",    api_key),
        ]
        if not val
    ]
    if missing:
        raise RuntimeError(
            f"Azure provider selected but missing env vars: {', '.join(missing)}"
        )

    log.info(
        "LLM provider=azure endpoint=%s deployment=%s api_version=%s",
        endpoint, deployment, api_version,
    )

    return AzureChatOpenAI(
        azure_endpoint=endpoint,
        azure_deployment=deployment,
        api_version=api_version,
        api_key=api_key,
        temperature=settings.llm_temperature,
    )


def _build_openai_llm():
    kwargs: dict = {
        "model": settings.llm_model,
        "temperature": settings.llm_temperature,
        "api_key": settings.openai_api_key,
    }
    if settings.openai_base_url:
        kwargs["base_url"] = settings.openai_base_url

    log.info("LLM provider=openai model=%s", settings.llm_model)
    return ChatOpenAI(**kwargs)


def _build_llm():
    """Return an LLM with the registered tools bound."""
    provider = _resolve_provider()

    if provider == "mock":
        log.warning(
            "LLM provider=mock — no network calls will be made. "
            "Set AZURE_OPENAI_* or OPENAI_API_KEY to use a real model."
        )
        return MockToolCallingLLM().bind_tools(TOOLS)
    if provider == "azure":
        return _build_azure_llm().bind_tools(TOOLS)
    return _build_openai_llm().bind_tools(TOOLS)


# ---------------------------------------------------------------------------
# Node-backend helpers
# ---------------------------------------------------------------------------

def _airlock_headers(user_token: str) -> dict[str, str]:
    """Standard JSON + bearer headers for Node API calls."""
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {user_token}",
    }


def _raise_for_airlock(resp: httpx.Response, context: str) -> None:
    """Convert a non-2xx Node response into a descriptive RuntimeError."""
    if resp.status_code < 400:
        return
    try:
        detail = resp.json().get("error", resp.text)
    except Exception:
        detail = resp.text
    raise RuntimeError(
        f"Airlock rejected {context} ({resp.status_code}): {detail}"
    )


def _sync_decision_to_node(state: AgentState, status: str) -> None:
    """
    POST the human's decision to Node's /api/actions/:id/approve or /reject.

    This is what moves the Action out of PENDING_APPROVAL on the Node side
    AND fires Node's tenant-scoped `actionStateChanged` socket event to the
    owning user's private room.

    Uses the end user's JWT — Node re-verifies environment ownership through
    that token, exactly as it does for /propose.
    """
    action_id  = state.get("airlock_action_id")
    user_token = state.get("user_token")

    if not action_id or not user_token:
        raise RuntimeError(
            "_sync_decision_to_node: missing airlock_action_id or user_token"
        )

    endpoint = "approve" if status == "APPROVED" else "reject"
    url = (
        f"{settings.airlock_base_url.rstrip('/')}"
        f"/api/actions/{action_id}/{endpoint}"
    )

    log.info("sync decision -> POST %s", url)

    with httpx.Client(timeout=settings.airlock_request_timeout) as client:
        resp = client.post(url, headers=_airlock_headers(user_token))
        _raise_for_airlock(resp, f"{endpoint} sync")


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------

def llm_reasoner(state: AgentState) -> dict:
    """
    Decide whether to reply to the user or to propose a tool call.

    Reads the whole transcript, prepends the system prompt, and returns the
    assistant message. If the message contains ``tool_calls``, the routing
    edge will send the graph into ``propose_action``.
    """
    llm = _build_llm()
    history: list[BaseMessage] = [
        SystemMessage(content=SYSTEM_PROMPT),
        *state.get("messages", []),
    ]
    response = llm.invoke(history)
    return {"messages": [response]}


def propose_action(state: AgentState) -> dict:
    """
    Intercept the LLM's tool call and file it with the Airlock Node backend
    for human approval. Authenticates with the END USER'S JWT so the Node
    route's per-user Environment ownership check can pass.
    """
    last = state["messages"][-1]
    if not isinstance(last, AIMessage) or not last.tool_calls:
        raise RuntimeError("propose_action reached without a tool call")

    user_token = state.get("user_token")
    if not user_token:
        raise RuntimeError(
            "propose_action: state['user_token'] is missing. "
            "POST /invoke must be called with the end user's JWT."
        )

    tool_call = last.tool_calls[0]

    payload = {
        "environmentId": state["environment_id"],
        "toolName": tool_call["name"],
        "parameters": tool_call["args"] or {},
    }

    url = f"{settings.airlock_base_url.rstrip('/')}/api/actions/propose"

    log.info(
        "propose_action -> POST %s tool=%s env=%s",
        url,
        tool_call["name"],
        state["environment_id"],
    )

    with httpx.Client(timeout=settings.airlock_request_timeout) as client:
        resp = client.post(url, json=payload, headers=_airlock_headers(user_token))
        _raise_for_airlock(resp, "the proposal")
        body = resp.json()

    action = body.get("action") or {}
    action_id = action.get("id")
    if not action_id:
        raise RuntimeError(f"Airlock did not return an action id: {body!r}")

    return {
        "pending_tool_call": {
            "name": tool_call["name"],
            "args": tool_call["args"] or {},
            "id": tool_call["id"],
        },
        "airlock_action_id": action_id,
        "approval_status": "PENDING",
    }


def human_gate(state: AgentState) -> dict:
    """
    HITL breakpoint.

    ``interrupt()`` suspends the graph inside this node and surfaces the
    payload to the caller. When the graph is resumed with
    ``Command(resume=<value>)``, ``interrupt()`` returns that value instead
    of raising.

    After capturing the decision, we POST it back to the Node backend so
    that:
      1. The Action status on Node moves out of PENDING_APPROVAL.
      2. Node fires the tenant-scoped `actionStateChanged` socket event
         (io.to(userId).emit(...)) to the owning user's private room.
    """
    decision = interrupt(
        {
            "type": "approval_request",
            "airlock_action_id": state.get("airlock_action_id"),
            "tool_call": state.get("pending_tool_call"),
            "question": "Approve or reject this proposed action?",
        }
    )

    if isinstance(decision, dict):
        status = decision.get("approval_status")
    else:
        status = decision

    if status not in ("APPROVED", "REJECTED"):
        # Never silently default to APPROVED.
        status = "REJECTED"

    # Mirror the decision to Node before we branch downstream.
    _sync_decision_to_node(state, status)

    return {"approval_status": status}


def execute_tool(state: AgentState) -> dict:
    """
    Run the approved tool via the MCP microservice.

    Context hand-off (never visible to the LLM):
      * environment_id and user_token come from graph state, not from
        the tool call arguments.
      * They travel to the MCP server as HTTP headers.
      * The MCP server pulls credentials just-in-time from the Node
        backend and executes the operation.
    """
    from mcp_client import MCPClient  # local import to avoid cycles at import time

    tool_call = state.get("pending_tool_call") or {}
    name = tool_call.get("name")
    args = tool_call.get("args") or {}
    call_id = tool_call.get("id")

    if not name:
        raise RuntimeError("execute_tool reached without a tool name")

    environment_id = state.get("environment_id")
    user_token = state.get("user_token")
    if not environment_id or not user_token:
        raise RuntimeError(
            "execute_tool: state is missing environment_id or user_token"
        )

    log.info(
        "execute_tool -> MCP %s(%s) env=%s",
        name, args, environment_id,
    )

    try:
        result = MCPClient().call_tool(name, args, environment_id, user_token)
    except Exception as exc:
        log.exception("MCP tool call failed")
        result = {"error": str(exc), "tool": name}

    observation = ToolMessage(
        content=json.dumps(result) if not isinstance(result, str) else result,
        tool_call_id=call_id or name,
        name=name,
    )
    return {"messages": [observation], "pending_tool_call": None}


def handle_rejection(state: AgentState) -> dict:
    """Close the tool-call loop cleanly and instruct the LLM not to retry."""
    tool_call = state.get("pending_tool_call") or {}
    call_id = tool_call.get("id") or tool_call.get("name") or "rejected"

    tool_msg = ToolMessage(
        content="NOT EXECUTED — the human operator rejected this action.",
        tool_call_id=call_id,
        name=tool_call.get("name"),
    )
    system_note = SystemMessage(
        content=(
            "The user rejected the proposed action. Acknowledge the rejection "
            "to the user in one short sentence and do NOT retry the same tool "
            "call unless the user explicitly asks you to."
        )
    )
    return {"messages": [tool_msg, system_note], "pending_tool_call": None}


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

def route_after_llm(state: AgentState) -> str:
    """If the LLM emitted a tool call, file it; otherwise the turn is done."""
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and last.tool_calls:
        return "propose_action"
    return END


def route_after_gate(state: AgentState) -> str:
    """Dispatch on the human decision recorded by ``human_gate``."""
    return (
        "execute_tool"
        if state.get("approval_status") == "APPROVED"
        else "handle_rejection"
    )


# ---------------------------------------------------------------------------
# Graph factory
# ---------------------------------------------------------------------------

def build_graph(checkpointer):
    """
    Compile the graph with the supplied checkpointer.

    The checkpointer is what allows ``interrupt()`` to persist across HTTP
    requests — a fresh FastAPI request on ``/resume`` rehydrates the graph
    state from SQLite and continues exactly where it paused.
    """
    builder = StateGraph(AgentState)

    builder.add_node("llm_reasoner", llm_reasoner)
    builder.add_node("propose_action", propose_action)
    builder.add_node("human_gate", human_gate)
    builder.add_node("execute_tool", execute_tool)
    builder.add_node("handle_rejection", handle_rejection)

    builder.add_edge(START, "llm_reasoner")

    builder.add_conditional_edges(
        "llm_reasoner",
        route_after_llm,
        {"propose_action": "propose_action", END: END},
    )

    # interrupt() lives inside human_gate, so this edge is what actually
    # pauses the graph right after propose_action has run.
    builder.add_edge("propose_action", "human_gate")

    builder.add_conditional_edges(
        "human_gate",
        route_after_gate,
        {
            "execute_tool": "execute_tool",
            "handle_rejection": "handle_rejection",
        },
    )

    builder.add_edge("execute_tool", "llm_reasoner")
    builder.add_edge("handle_rejection", "llm_reasoner")

    return builder.compile(checkpointer=checkpointer)   