"""
Importing this package is what triggers every provider's
@ProviderFactory.register(...) decorator. Adding a new provider file
is a one-line addition here (or an auto-discovery loop) — no existing
code changes. That is the Open-Closed Principle in practice.
"""

from .base import CloudProvider, CloudCredentials
from .factory import ProviderFactory

# Importing the modules below causes their @register decorators to run.
from . import aws_provider   # noqa: F401
from . import gcp_provider   # noqa: F401
from . import azure_provider # noqa: F401

__all__ = ["CloudProvider", "CloudCredentials", "ProviderFactory"]