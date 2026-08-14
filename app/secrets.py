"""Deprecated module: Secrets are now managed via environment variables and app/config.py."""

from app.config import settings


class DeprecatedSecrets:
    """Backward compatibility shim mapping old secret properties to settings."""

    @property
    def e621_username(self) -> str:
        return settings.e621_username

    @property
    def postgresql_user(self) -> str:
        return settings.postgres_user

    @property
    def postgresql_password(self) -> str:
        return settings.postgres_password


secrets = DeprecatedSecrets()