"""
Tool registry — the LLM-visible surface.

Each tool's docstring is what the LLM sees when deciding whether to emit
a tool call. The bodies are never executed; execution routes through
mcp-service. Keep docstrings crisp and unambiguous.
"""

from __future__ import annotations

import json

from langchain_core.tools import tool


# ---------------------------------------------------------------------------
# EC2
# ---------------------------------------------------------------------------
@tool
def start_ec2_instance(instance_id: str) -> str:
    """Start a stopped AWS EC2 instance.

    Use this when the user asks to start, boot up, or power on an EC2
    instance.

    Args:
        instance_id: The EC2 instance identifier, e.g. "i-0abc1234def567890".
    """
    return json.dumps({"tool": "start_ec2_instance", "args": {"instance_id": instance_id}})


@tool
def stop_ec2_instance(instance_id: str) -> str:
    """Stop a running AWS EC2 instance.

    Use this when the user asks to stop, shut down, or power off a
    running EC2 instance.

    Args:
        instance_id: The EC2 instance identifier, e.g. "i-0abc1234def567890".
    """
    return json.dumps({"tool": "stop_ec2_instance", "args": {"instance_id": instance_id}})


@tool
def reboot_ec2_instance(instance_id: str) -> str:
    """Reboot a running AWS EC2 instance (graceful OS restart, does not
    terminate the instance).

    Use this when the user asks to reboot or restart an EC2 instance's
    operating system.

    Args:
        instance_id: The EC2 instance identifier, e.g. "i-0abc1234def567890".
    """
    return json.dumps({"tool": "reboot_ec2_instance", "args": {"instance_id": instance_id}})


@tool
def terminate_ec2_instance(instance_id: str) -> str:
    """Permanently terminate (destroy) an AWS EC2 instance. This action is
    DESTRUCTIVE and cannot be undone. Instance storage is destroyed.

    Use this when the user explicitly asks to terminate or permanently
    delete an EC2 instance.

    Args:
        instance_id: The EC2 instance identifier, e.g. "i-0abc1234def567890".
    """
    return json.dumps({"tool": "terminate_ec2_instance", "args": {"instance_id": instance_id}})


@tool
def create_ec2_instance(name: str = "airlock-node", instance_type: str = "t3.micro") -> str:
    """Provision a new Amazon Linux 2023 EC2 instance in the environment's
    region.

    IMPORTANT ADVISORY TO SURFACE TO THE OPERATOR: Console or Terraform/IaC
    is recommended for production EC2 creation with custom VPC, Security
    Groups, and KeyPairs. This tool provisions a default Free-Tier Amazon
    Linux 2023 instance with default VPC/security-group/keypair settings.

    Args:
        name: Friendly Name tag for the instance (default: "airlock-node").
        instance_type: EC2 instance type (default: "t3.micro").
    """
    return json.dumps(
        {"tool": "create_ec2_instance", "args": {"name": name, "instance_type": instance_type}}
    )


# ---------------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------------
@tool
def restart_rds_instance(db_instance_identifier: str) -> str:
    """Reboot an AWS RDS database instance.

    Args:
        db_instance_identifier: The RDS instance identifier,
            e.g. "prod-postgres-01".
    """
    return json.dumps(
        {"tool": "restart_rds_instance", "args": {"db_instance_identifier": db_instance_identifier}}
    )


@tool
def start_rds_instance(db_instance_identifier: str) -> str:
    """Start a stopped AWS RDS database instance.

    Args:
        db_instance_identifier: The RDS instance identifier.
    """
    return json.dumps(
        {"tool": "start_rds_instance", "args": {"db_instance_identifier": db_instance_identifier}}
    )


@tool
def stop_rds_instance(db_instance_identifier: str) -> str:
    """Stop a running AWS RDS database instance (the database will be
    unavailable until started again).

    Args:
        db_instance_identifier: The RDS instance identifier.
    """
    return json.dumps(
        {"tool": "stop_rds_instance", "args": {"db_instance_identifier": db_instance_identifier}}
    )


# ---------------------------------------------------------------------------
# S3
# ---------------------------------------------------------------------------
@tool
def create_s3_bucket(bucket_name: str) -> str:
    """Create a new AWS S3 bucket in the environment's region.

    Args:
        bucket_name: Globally-unique bucket name, e.g. "airlock-test-2026".
    """
    return json.dumps({"tool": "create_s3_bucket", "args": {"bucket_name": bucket_name}})


@tool
def delete_s3_bucket(bucket_name: str) -> str:
    """Delete an AWS S3 bucket. The bucket MUST be empty.

    Args:
        bucket_name: The bucket name to delete.
    """
    return json.dumps({"tool": "delete_s3_bucket", "args": {"bucket_name": bucket_name}})


# ---------------------------------------------------------------------------
# Lambda
# ---------------------------------------------------------------------------
@tool
def invoke_lambda_function(function_name: str, payload_json: str = "{}") -> str:
    """Synchronously invoke an AWS Lambda function and return its response.

    Args:
        function_name: The Lambda function name, e.g. "airlock-hello".
        payload_json: JSON string to send as the event payload (default "{}").
    """
    return json.dumps(
        {"tool": "invoke_lambda_function", "args": {"function_name": function_name, "payload_json": payload_json}}
    )


# ---------------------------------------------------------------------------
# GCP (kept as-is from previous version)
# ---------------------------------------------------------------------------
@tool
def scale_gke_node_pool(cluster_id: str, node_pool_id: str, node_count: int) -> str:
    """Resize a Google Kubernetes Engine node pool.

    Args:
        cluster_id: GKE cluster identifier.
        node_pool_id: Node pool identifier.
        node_count: Desired number of nodes.
    """
    return json.dumps(
        {
            "tool": "scale_gke_node_pool",
            "args": {
                "cluster_id": cluster_id,
                "node_pool_id": node_pool_id,
                "node_count": node_count,
            },
        }
    )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
TOOLS = [
    # EC2
    start_ec2_instance,
    stop_ec2_instance,
    reboot_ec2_instance,
    terminate_ec2_instance,
    create_ec2_instance,
    # RDS
    restart_rds_instance,
    start_rds_instance,
    stop_rds_instance,
    # S3
    create_s3_bucket,
    delete_s3_bucket,
    # Lambda
    invoke_lambda_function,
    # GCP
    scale_gke_node_pool,
]

TOOL_REGISTRY = {t.name: t for t in TOOLS}