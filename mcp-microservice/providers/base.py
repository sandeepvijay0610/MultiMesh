"""
Abstract base class for every cloud provider.

Design notes:
  * Only the 4 "core" operations are @abstractmethod. Every other tool
    has a concrete default that returns an "unsupported" dict, so adding
    a new tool never forces edits in GCP/Azure/OCI providers.
  * ProviderFactory registration is untouched — see factory.py.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class CloudCredentials:
    access_key: str
    secret_key: str


class CloudProvider(ABC):
    name: str = "base"

    def __init__(
        self,
        credentials: CloudCredentials | None,
        dry_run: bool = False,
    ) -> None:
        self.credentials = credentials
        self.dry_run = dry_run

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @property
    def provider_name(self) -> str:
        """Alias for `self.name` — set by ProviderFactory.register(...)."""
        return self.name

    def _should_simulate(self) -> bool:
        """
        Default policy: simulate when global DRY_RUN is on or no
        credentials were supplied. AWSProvider overrides this with a
        stricter check that also treats AKIA_TEST* keys as dry-run.
        """
        if self.dry_run:
            return True
        if self.credentials is None:
            return True
        ak = (self.credentials.access_key or "").strip()
        sk = (self.credentials.secret_key or "").strip()
        return not ak or not sk

    def _unsupported(self, operation: str) -> dict[str, Any]:
        """
        Default response for tools a provider does not implement.
        Returned by every concrete extension method below unless the
        provider overrides it. Matches the Postman 03d contract shape.
        """
        return {
            "provider": self.provider_name,
            "operation": operation,
            "state": "unsupported",
            "dry_run": self._should_simulate(),
            "error": f"{operation} is not implemented for provider {self.provider_name}",
        }

    # ------------------------------------------------------------------
    # Abstract core operations — must be implemented by every provider.
    # ------------------------------------------------------------------
    @abstractmethod
    def start_compute_instance(self, instance_id: str) -> dict: ...

    @abstractmethod
    def stop_compute_instance(self, instance_id: str) -> dict: ...

    @abstractmethod
    def reboot_database(self, db_instance_identifier: str) -> dict: ...

    @abstractmethod
    def scale_cluster(
        self, cluster_id: str, node_pool_id: str, node_count: int
    ) -> dict: ...

    # ------------------------------------------------------------------
    # Extended concrete operations — default to unsupported.
    # AWS overrides. GCP/Azure inherit and stay closed-for-modification.
    # ------------------------------------------------------------------

    # ---- Read-only discovery ----------------------------------------
    def list_resources(self) -> dict[str, Any]:
        return {
            "provider": self.provider_name,
            "dry_run": self._should_simulate(),
            "resources": {
                "ec2_instances": [],
                "rds_instances": [],
                "s3_buckets": [],
                "lambda_functions": [],
            },
            "errors": {},
        }

    # ---- EC2 extensions ----------------------------------------------
    def reboot_compute_instance(self, instance_id: str) -> dict[str, Any]:
        return self._unsupported("RebootInstances")

    def terminate_compute_instance(self, instance_id: str) -> dict[str, Any]:
        return self._unsupported("TerminateInstances")

    def create_compute_instance(
        self, name: str = "airlock-node", instance_type: str = "t3.micro"
    ) -> dict[str, Any]:
        return self._unsupported("RunInstances")

    # ---- RDS extensions ----------------------------------------------
    def start_database(self, db_instance_identifier: str) -> dict[str, Any]:
        return self._unsupported("StartDBInstance")

    def stop_database(self, db_instance_identifier: str) -> dict[str, Any]:
        return self._unsupported("StopDBInstance")

    # ---- S3 ----------------------------------------------------------
    def create_bucket(self, bucket_name: str) -> dict[str, Any]:
        return self._unsupported("CreateBucket")

    def delete_bucket(self, bucket_name: str) -> dict[str, Any]:
        return self._unsupported("DeleteBucket")

    # ---- Lambda ------------------------------------------------------
    def invoke_function(
        self, function_name: str, payload_json: str = "{}"
    ) -> dict[str, Any]:
        return self._unsupported("Invoke")