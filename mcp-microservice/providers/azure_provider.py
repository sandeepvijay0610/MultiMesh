"""Azure provider. All operations return explicit not-implemented errors."""

from __future__ import annotations

from .base import CloudCredentials, CloudProvider
from .factory import ProviderFactory


@ProviderFactory.register("AZURE")
class AzureProvider(CloudProvider):

    def __init__(self, credentials: CloudCredentials | None, dry_run: bool = False) -> None:
        super().__init__(credentials, dry_run=dry_run)

    def start_compute_instance(self, instance_id: str) -> dict:
        return {"provider": "Azure", "error": "start_compute_instance is not implemented for Azure in this provider"}

    def stop_compute_instance(self, instance_id: str) -> dict:
        return {"provider": "Azure", "error": "stop_compute_instance is not implemented for Azure in this provider"}

    def reboot_database(self, db_instance_identifier: str) -> dict:
        return {"provider": "Azure", "error": "reboot_database is not implemented for Azure in this provider"}

    def scale_cluster(self, cluster_id: str, node_pool_id: str, node_count: int) -> dict:
        return {"provider": "Azure", "error": "scale_cluster is not implemented for Azure in this provider"}