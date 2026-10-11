"""
LangGraph shared state for the Airlock HITL agent.

The ``messages`` channel uses ``add_messages`` so that every node returning
``{"messages": [...]}`` appends to the running transcript rather than
overwriting it. Every other key uses the default "last write wins" reducer.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, TypedDict

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages


# Approval lifecycle mirror of the Node backend's Action.status enum.
ApprovalStatus = Literal["PENDING", "APPROVED", "REJECTED"]


class AgentState(TypedDict, total=False):
    # Running conversation transcript (system + human + ai + tool messages).
    messages: Annotated[list[BaseMessage], add_messages]

    # Which Airlock environment the tool call should run against.
    environment_id: str

    # ------------------------------------------------------------------
    # The end user's JWT, forwarded verbatim to the Node Airlock backend
    # so that /api/actions/propose can enforce per-user ownership of the
    # target Environment. Multi-tenant — never replace this with a static
    # service token.
    #
    # SECURITY: this value is persisted inside the SQLite checkpoint that
    # backs interrupt()/resume. Treat the checkpoint file as a secret.
    # ------------------------------------------------------------------
    user_token: str

    # The raw tool call the LLM produced, e.g.
    # {"name": "stop_ec2_instance", "args": {...}, "id": "call_abc"}.
    # Cleared once execute_tool / handle_rejection has consumed it.
    pending_tool_call: Optional[dict]

    # The ID returned by POST /api/actions/propose on the Node backend.
    airlock_action_id: Optional[str]

    # PENDING until an out-of-band /resume call flips it.
    approval_status: ApprovalStatus