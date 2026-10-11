"""
AWS provider using boto3.

Dry-run policy (in priority order):
  1. self.dry_run is True                  -> simulate
  2. credentials are None or empty         -> simulate
  3. access_key starts with "AKIA_TEST"    -> simulate (E2E test marker)
  4. access_key contains mask chars        -> simulate

Otherwise: real boto3 call. Live errors are caught and normalized so
the caller can see aws_error_code / request_id without a traceback.
"""

from __future__ import annotations

import logging

from config import settings
from .base import CloudCredentials, CloudProvider
from .factory import ProviderFactory

log = logging.getLogger("airlock.mcp.aws")


@ProviderFactory.register("AWS")
class AWSProvider(CloudProvider):

    def __init__(
        self, credentials: CloudCredentials | None, dry_run: bool = False
    ) -> None:
        super().__init__(credentials, dry_run=dry_run)
        self.region = settings.aws_default_region

    # ------------------------------------------------------------------ policy
    def _should_simulate(self) -> bool:
        if self.dry_run:
            return True
        if self.credentials is None:
            return True
        ak = (self.credentials.access_key or "").strip()
        sk = (self.credentials.secret_key or "").strip()
        if not ak or not sk:
            return True
        if ak.startswith("AKIA_TEST"):
            return True
        if "*" in ak or "..." in ak or "***" in ak:
            return True
        return False

    def _boto_client(self, service: str):
        import boto3  # local import so the module loads without AWS SDK
        assert self.credentials is not None
        return boto3.client(
            service,
            region_name=self.region,
            aws_access_key_id=self.credentials.access_key,
            aws_secret_access_key=self.credentials.secret_key,
        )

    @staticmethod
    def _client_error_payload(
        e, *, service: str, operation: str, dry_run: bool, **extras
    ) -> dict:
        err = e.response.get("Error", {}) or {}
        meta = e.response.get("ResponseMetadata", {}) or {}
        payload = {
            "provider": "AWS",
            "service": service,
            "operation": operation,
            "state": "failed",
            "dry_run": dry_run,
            "aws_error_code": err.get("Code"),
            "error": err.get("Message"),
            "request_id": meta.get("RequestId"),
        }
        payload.update(extras)
        return payload

    # ==================================================================
    # READ-ONLY DISCOVERY
    # ==================================================================
    def list_resources(self) -> dict:
        """
        Return inventory of EC2, RDS, S3, and Lambda resources.
        Per-service try/except so an IAM user with narrow permissions
        still gets back whatever they *are* allowed to see.
        """
        if self._should_simulate():
            log.info("AWS dry-run: list_resources")
            return {
                "provider": "AWS",
                "dry_run": True,
                "region": self.region,
                "resources": {
                    "ec2_instances": [
                        {
                            "id": "i-0a1b2c3d4e5f67890",
                            "name": "web-prod-01",
                            "type": "t3.micro",
                            "state": "running",
                            "public_ip": "203.0.113.42",
                            "private_ip": "10.0.1.15",
                            "az": "us-east-1a",
                        },
                        {
                            "id": "i-0f9e8d7c6b5a43210",
                            "name": "worker-prod-01",
                            "type": "t3.small",
                            "state": "stopped",
                            "public_ip": None,
                            "private_ip": "10.0.1.27",
                            "az": "us-east-1b",
                        },
                    ],
                    "rds_instances": [
                        {
                            "id": "prod-postgres-01",
                            "engine": "postgres",
                            "status": "available",
                            "class": "db.t3.micro",
                            "endpoint": "prod-postgres-01.cxyz.us-east-1.rds.amazonaws.com",
                        },
                    ],
                    "s3_buckets": [
                        {"name": "airlock-test-bucket", "creation_date": "2025-01-15T10:00:00Z"},
                        {"name": "airlock-logs-archive", "creation_date": "2025-02-02T14:30:00Z"},
                    ],
                    "lambda_functions": [
                        {"name": "airlock-hello", "runtime": "python3.11",
                         "state": "Active", "last_modified": "2025-03-01T09:15:00Z"},
                    ],
                },
                "errors": {},
            }

        resources: dict[str, list] = {
            "ec2_instances": [],
            "rds_instances": [],
            "s3_buckets": [],
            "lambda_functions": [],
        }
        errors: dict[str, str] = {}

        # ---- EC2 ----
        try:
            ec2 = self._boto_client("ec2")
            paginator = ec2.get_paginator("describe_instances")
            for page in paginator.paginate():
                for res in page.get("Reservations", []):
                    for inst in res.get("Instances", []):
                        name = ""
                        for tag in inst.get("Tags", []) or []:
                            if tag.get("Key") == "Name":
                                name = tag.get("Value", "")
                                break
                        resources["ec2_instances"].append({
                            "id": inst.get("InstanceId"),
                            "name": name,
                            "type": inst.get("InstanceType"),
                            "state": (inst.get("State") or {}).get("Name"),
                            "public_ip": inst.get("PublicIpAddress"),
                            "private_ip": inst.get("PrivateIpAddress"),
                            "az": (inst.get("Placement") or {}).get("AvailabilityZone"),
                        })
        except Exception as e:  # noqa: BLE001
            log.warning("list_resources/ec2 failed: %s", e)
            errors["ec2"] = str(e)

        # ---- RDS ----
        try:
            rds = self._boto_client("rds")
            for db in rds.describe_db_instances().get("DBInstances", []):
                endpoint = (db.get("Endpoint") or {}).get("Address")
                resources["rds_instances"].append({
                    "id": db.get("DBInstanceIdentifier"),
                    "engine": db.get("Engine"),
                    "status": db.get("DBInstanceStatus"),
                    "class": db.get("DBInstanceClass"),
                    "endpoint": endpoint,
                })
        except Exception as e:  # noqa: BLE001
            log.warning("list_resources/rds failed: %s", e)
            errors["rds"] = str(e)

        # ---- S3 ----
        try:
            s3 = self._boto_client("s3")
            for b in s3.list_buckets().get("Buckets", []):
                cd = b.get("CreationDate")
                resources["s3_buckets"].append({
                    "name": b.get("Name"),
                    "creation_date": cd.isoformat() if hasattr(cd, "isoformat") else str(cd),
                })
        except Exception as e:  # noqa: BLE001
            log.warning("list_resources/s3 failed: %s", e)
            errors["s3"] = str(e)

        # ---- Lambda ----
        try:
            lam = self._boto_client("lambda")
            for f in lam.list_functions().get("Functions", []):
                resources["lambda_functions"].append({
                    "name": f.get("FunctionName"),
                    "runtime": f.get("Runtime"),
                    "state": f.get("State") or "Active",
                    "last_modified": f.get("LastModified"),
                })
        except Exception as e:  # noqa: BLE001
            log.warning("list_resources/lambda failed: %s", e)
            errors["lambda"] = str(e)

        return {
            "provider": "AWS",
            "dry_run": False,
            "region": self.region,
            "resources": resources,
            "errors": errors,
        }

    # ==================================================================
    # EC2
    # ==================================================================
    def start_compute_instance(self, instance_id: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: StartInstances(%s)", instance_id)
            return {
                "provider": "AWS", "service": "EC2",
                "operation": "StartInstances", "instance_id": instance_id,
                "state": "pending", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: StartInstances(%s)", instance_id)
        try:
            resp = self._boto_client("ec2").start_instances(InstanceIds=[instance_id])
        except ClientError as e:
            return self._client_error_payload(
                e, service="EC2", operation="StartInstances",
                dry_run=False, instance_id=instance_id,
            )
        state = (resp.get("StartingInstances", [{}])[0]
                 .get("CurrentState", {}).get("Name", "pending"))
        return {
            "provider": "AWS", "service": "EC2",
            "operation": "StartInstances", "instance_id": instance_id,
            "state": state, "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    def stop_compute_instance(self, instance_id: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: StopInstances(%s)", instance_id)
            return {
                "provider": "AWS", "service": "EC2",
                "operation": "StopInstances", "instance_id": instance_id,
                "state": "stopping", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: StopInstances(%s)", instance_id)
        try:
            resp = self._boto_client("ec2").stop_instances(InstanceIds=[instance_id])
        except ClientError as e:
            return self._client_error_payload(
                e, service="EC2", operation="StopInstances",
                dry_run=False, instance_id=instance_id,
            )
        state = (resp.get("StoppingInstances", [{}])[0]
                 .get("CurrentState", {}).get("Name", "stopping"))
        return {
            "provider": "AWS", "service": "EC2",
            "operation": "StopInstances", "instance_id": instance_id,
            "state": state, "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    def reboot_compute_instance(self, instance_id: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: RebootInstances(%s)", instance_id)
            return {
                "provider": "AWS", "service": "EC2",
                "operation": "RebootInstances", "instance_id": instance_id,
                "state": "rebooting", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: RebootInstances(%s)", instance_id)
        try:
            resp = self._boto_client("ec2").reboot_instances(InstanceIds=[instance_id])
        except ClientError as e:
            return self._client_error_payload(
                e, service="EC2", operation="RebootInstances",
                dry_run=False, instance_id=instance_id,
            )
        return {
            "provider": "AWS", "service": "EC2",
            "operation": "RebootInstances", "instance_id": instance_id,
            "state": "rebooting", "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    def terminate_compute_instance(self, instance_id: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: TerminateInstances(%s)", instance_id)
            return {
                "provider": "AWS", "service": "EC2",
                "operation": "TerminateInstances", "instance_id": instance_id,
                "state": "shutting-down", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: TerminateInstances(%s)", instance_id)
        try:
            resp = self._boto_client("ec2").terminate_instances(InstanceIds=[instance_id])
        except ClientError as e:
            return self._client_error_payload(
                e, service="EC2", operation="TerminateInstances",
                dry_run=False, instance_id=instance_id,
            )
        state = (resp.get("TerminatingInstances", [{}])[0]
                 .get("CurrentState", {}).get("Name", "shutting-down"))
        return {
            "provider": "AWS", "service": "EC2",
            "operation": "TerminateInstances", "instance_id": instance_id,
            "state": state, "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    def create_compute_instance(
        self, name: str = "airlock-node", instance_type: str = "t3.micro"
    ) -> dict:
        advisory = (
            "Console/IaC (Terraform) is recommended for production EC2 "
            "creation with custom VPC, Security Groups, and KeyPairs. "
            "Provisioned default Free-Tier Amazon Linux 2023 instance."
        )
        if self._should_simulate():
            log.info("AWS dry-run: RunInstances(name=%s, type=%s)", name, instance_type)
            return {
                "provider": "AWS", "service": "EC2",
                "operation": "RunInstances",
                "instance_id": "i-simulated-0000000000000000",
                "instance_type": instance_type,
                "state": "pending",
                "advisory": advisory,
                "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: RunInstances(name=%s, type=%s)", name, instance_type)
        try:
            ec2 = self._boto_client("ec2")
            images = ec2.describe_images(
                Owners=["amazon"],
                Filters=[
                    {"Name": "name", "Values": ["al2023-ami-2023.*-kernel-6.1-x86_64"]},
                    {"Name": "state", "Values": ["available"]},
                ],
            ).get("Images", [])
            if not images:
                return {
                    "provider": "AWS", "service": "EC2",
                    "operation": "RunInstances", "state": "failed",
                    "dry_run": False,
                    "error": "No Amazon Linux 2023 x86_64 AMI found in this region",
                    "advisory": advisory,
                }
            images.sort(key=lambda i: i.get("CreationDate", ""), reverse=True)
            ami_id = images[0]["ImageId"]
            resp = ec2.run_instances(
                ImageId=ami_id,
                InstanceType=instance_type,
                MinCount=1,
                MaxCount=1,
                TagSpecifications=[{
                    "ResourceType": "instance",
                    "Tags": [
                        {"Key": "Name", "Value": name},
                        {"Key": "ManagedBy", "Value": "MultiMesh-Airlock"},
                    ],
                }],
            )
        except ClientError as e:
            return self._client_error_payload(
                e, service="EC2", operation="RunInstances",
                dry_run=False, instance_type=instance_type, advisory=advisory,
            )
        inst = (resp.get("Instances") or [{}])[0]
        return {
            "provider": "AWS", "service": "EC2",
            "operation": "RunInstances",
            "instance_id": inst.get("InstanceId"),
            "instance_type": instance_type,
            "state": "pending",
            "advisory": advisory,
            "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    # ==================================================================
    # RDS
    # ==================================================================
    def reboot_database(self, db_instance_identifier: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: RebootDBInstance(%s)", db_instance_identifier)
            return {
                "provider": "AWS", "service": "RDS",
                "operation": "RebootDBInstance",
                "db_instance_identifier": db_instance_identifier,
                "state": "rebooting", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: RebootDBInstance(%s)", db_instance_identifier)
        try:
            resp = self._boto_client("rds").reboot_db_instance(
                DBInstanceIdentifier=db_instance_identifier
            )
        except ClientError as e:
            return self._client_error_payload(
                e, service="RDS", operation="RebootDBInstance",
                dry_run=False, db_instance_identifier=db_instance_identifier,
            )
        db = resp.get("DBInstance", {})
        return {
            "provider": "AWS", "service": "RDS",
            "operation": "RebootDBInstance",
            "db_instance_identifier": db_instance_identifier,
            "state": db.get("DBInstanceStatus", "rebooting"),
            "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    def start_database(self, db_instance_identifier: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: StartDBInstance(%s)", db_instance_identifier)
            return {
                "provider": "AWS", "service": "RDS",
                "operation": "StartDBInstance",
                "db_instance_identifier": db_instance_identifier,
                "state": "starting", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: StartDBInstance(%s)", db_instance_identifier)
        try:
            resp = self._boto_client("rds").start_db_instance(
                DBInstanceIdentifier=db_instance_identifier
            )
        except ClientError as e:
            return self._client_error_payload(
                e, service="RDS", operation="StartDBInstance",
                dry_run=False, db_instance_identifier=db_instance_identifier,
            )
        return {
            "provider": "AWS", "service": "RDS",
            "operation": "StartDBInstance",
            "db_instance_identifier": db_instance_identifier,
            "state": "starting", "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    def stop_database(self, db_instance_identifier: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: StopDBInstance(%s)", db_instance_identifier)
            return {
                "provider": "AWS", "service": "RDS",
                "operation": "StopDBInstance",
                "db_instance_identifier": db_instance_identifier,
                "state": "stopping", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: StopDBInstance(%s)", db_instance_identifier)
        try:
            resp = self._boto_client("rds").stop_db_instance(
                DBInstanceIdentifier=db_instance_identifier
            )
        except ClientError as e:
            return self._client_error_payload(
                e, service="RDS", operation="StopDBInstance",
                dry_run=False, db_instance_identifier=db_instance_identifier,
            )
        return {
            "provider": "AWS", "service": "RDS",
            "operation": "StopDBInstance",
            "db_instance_identifier": db_instance_identifier,
            "state": "stopping", "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    # ==================================================================
    # S3
    # ==================================================================
    def create_bucket(self, bucket_name: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: CreateBucket(%s)", bucket_name)
            return {
                "provider": "AWS", "service": "S3",
                "operation": "CreateBucket", "bucket_name": bucket_name,
                "state": "created", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: CreateBucket(%s)", bucket_name)
        try:
            s3 = self._boto_client("s3")
            if self.region == "us-east-1":
                resp = s3.create_bucket(Bucket=bucket_name)
            else:
                resp = s3.create_bucket(
                    Bucket=bucket_name,
                    CreateBucketConfiguration={"LocationConstraint": self.region},
                )
        except ClientError as e:
            return self._client_error_payload(
                e, service="S3", operation="CreateBucket",
                dry_run=False, bucket_name=bucket_name,
            )
        return {
            "provider": "AWS", "service": "S3",
            "operation": "CreateBucket", "bucket_name": bucket_name,
            "state": "created", "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    def delete_bucket(self, bucket_name: str) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: DeleteBucket(%s)", bucket_name)
            return {
                "provider": "AWS", "service": "S3",
                "operation": "DeleteBucket", "bucket_name": bucket_name,
                "state": "deleted", "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: DeleteBucket(%s)", bucket_name)
        try:
            resp = self._boto_client("s3").delete_bucket(Bucket=bucket_name)
        except ClientError as e:
            return self._client_error_payload(
                e, service="S3", operation="DeleteBucket",
                dry_run=False, bucket_name=bucket_name,
            )
        return {
            "provider": "AWS", "service": "S3",
            "operation": "DeleteBucket", "bucket_name": bucket_name,
            "state": "deleted", "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    # ==================================================================
    # Lambda
    # ==================================================================
    def invoke_function(
        self, function_name: str, payload_json: str = "{}"
    ) -> dict:
        if self._should_simulate():
            log.info("AWS dry-run: Invoke(%s)", function_name)
            return {
                "provider": "AWS", "service": "Lambda",
                "operation": "Invoke", "function_name": function_name,
                "status_code": 200, "response_payload": '{"simulated": true}',
                "dry_run": True,
            }
        from botocore.exceptions import ClientError
        log.info("AWS live: Invoke(%s)", function_name)
        try:
            lam = self._boto_client("lambda")
            resp = lam.invoke(
                FunctionName=function_name,
                InvocationType="RequestResponse",
                Payload=payload_json.encode("utf-8"),
            )
            raw = resp["Payload"].read().decode("utf-8")
        except ClientError as e:
            return self._client_error_payload(
                e, service="Lambda", operation="Invoke",
                dry_run=False, function_name=function_name,
            )
        return {
            "provider": "AWS", "service": "Lambda",
            "operation": "Invoke", "function_name": function_name,
            "status_code": resp.get("StatusCode"),
            "response_payload": raw,
            "dry_run": False,
            "request_id": resp.get("ResponseMetadata", {}).get("RequestId"),
        }

    # ==================================================================
    # Cluster scale — not implemented for AWS
    # ==================================================================
    def scale_cluster(
        self, cluster_id: str, node_pool_id: str, node_count: int
    ) -> dict:
        return {
            "provider": "AWS",
            "error": "scale_cluster is not implemented for AWS in this provider",
        }