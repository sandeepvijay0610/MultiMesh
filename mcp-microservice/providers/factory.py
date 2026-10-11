"""
ProviderFactory — a decorator-based registry.

Usage in a concrete provider module:

    @ProviderFactory.register("AWS")
    class AWSProvider(CloudProvider):
        ...

Adding GCP or Azure later requires ZERO edits to this file, to
server.py, or to any existing provider. That is the OCP guarantee.
"""

from __future__ import annotations

from typing import Dict, Type

from .base import CloudCredentials, CloudProvider


class ProviderFactory:
    _registry: Dict[str, Type[CloudProvider]] = {}

    @staticmethod
    def register(name: str):
        """
        Class decorator that registers a CloudProvider under `name`.
        Names are case-insensitive ("AWS" == "aws").
        """
        key = name.strip().upper()

        def decorator(cls: Type[CloudProvider]) -> Type[CloudProvider]:
            if not issubclass(cls, CloudProvider):
                raise TypeError(
                    f"{cls.__name__} must subclass CloudProvider to be registered"
                )
            if key in ProviderFactory._registry:
                raise ValueError(f"Provider '{key}' is already registered")
            cls.name = key
            ProviderFactory._registry[key] = cls
            return cls

        return decorator

    @staticmethod
    def create(
        name: str,
        credentials: CloudCredentials | None,
        dry_run: bool = False,
    ) -> CloudProvider:
        """Instantiate a registered provider by name."""
        key = (name or "").strip().upper()
        cls = ProviderFactory._registry.get(key)
        if cls is None:
            raise ValueError(
                f"Unknown provider '{name}'. "
                f"Registered: {sorted(ProviderFactory._registry)}"
            )
        return cls(credentials, dry_run=dry_run)

    @staticmethod
    def registered() -> list[str]:
        """Sorted list of registered provider names (for /health and logs)."""
        return sorted(ProviderFactory._registry.keys())