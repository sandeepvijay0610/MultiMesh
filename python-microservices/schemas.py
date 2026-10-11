"""Pydantic request/response models for the FastAPI surface."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class InvokeRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="Natural-language user request")
    environment_id: str = Field(
        ..., min_length=1, description="Airlock Environment id the tools run against"
    )
    user_token: str = Field(
        ...,
        min_length=1,
        description=(
            "The end user's JWT. Forwarded verbatim to the Node Airlock backend "
            "so that /api/actions/propose can verify the caller owns the target "
            "Environment. Must be the same token the user authenticates with "
            "against the Node API."
        ),
    )


class InvokeResponse(BaseModel):
    thread_id: str
    action_id: str | None = None
    approval_status: str
    interrupted: bool = Field(
        ..., description="True if the graph paused awaiting approval"
    )
    message: str | None = Field(
        default=None,
        description="Latest assistant text (the reply, or the preamble to the tool call)",
    )


class ResumeRequest(BaseModel):
    approval_status: Literal["APPROVED", "REJECTED"]
    # Optional: supply a fresh JWT if the original one may have expired while
    # the thread was paused. When omitted, the token stored in state is reused.
    user_token: str | None = Field(
        default=None,
        min_length=1,
        description="Optional refreshed user JWT; overrides the one stored in state.",
    )


class ResumeResponse(BaseModel):
    thread_id: str
    approval_status: str
    airlock_action_id: str | None = None
    interrupted: bool = Field(
        ..., description="True if the graph paused again on a new action"
    )
    message: str | None = None


class StateResponse(BaseModel):
    thread_id: str
    values: dict[str, Any]
    next: list[str] = Field(
        default_factory=list,
        description="Nodes that will execute next; non-empty means paused",
    )