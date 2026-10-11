"""GCP provider. Only scale_cluster is implemented (simulated)."""

from __future__ import annotations

import logging

from .base import CloudCredentials, CloudProvider
from .factory import ProviderFactory

log = logging.getLogger("airlock.mcp.gcp")


@ProviderFactory.register("GCP")
class GCPProvider(CloudProvider):

    def __init__(self, credentials: CloudCredentials | None, dry_run: bool = False) -> None:
        super().__init__(credentials, dry_run=dry_run)

    def start_compute_instance(self, instance_id: str) -> dict:
        return {
            "provider": "GCP",
            "error": "start_compute_instance is not implemented for GCP in this provider",
        }

    def stop_compute_instance(self, instance_id: str) -> dict:
        return {
            "provider": "GCP",
            "error": "stop_compute_instance is not implemented for GCP in this provider",
        }

    def reboot_database(self, db_instance_identifier: str) -> dict:
        return {
            "provider": "GCP",
            "error": "reboot_database is not implemented for GCP in this provider",
        }

    def scale_cluster(
        self, cluster_id: str, node_pool_id: str, node_count: int
    ) -> dict:
        log.info(
            "GCP simulated: scale_gke_node_pool(%s, %s, %d)",
            cluster_id, node_pool_id, node_count,
        )
        return {
            "provider": "GCP",
            "service": "GKE",
            "operation": "SetNodePoolSize",
            "cluster_id": cluster_id,
            "node_pool_id": node_pool_id,
            "node_count": node_count,
            "state": "reconciling",
            "dry_run": True,
        }