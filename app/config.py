"""Configuration settings loaded from environment variables and optional .env file."""

import os
from pathlib import Path


def _load_env_file() -> None:
    """Loads key-value pairs from a .env file into os.environ if not already set."""
    # Look for .env in current working directory or root of repository
    env_paths = [Path(".env"), Path(__file__).resolve().parent.parent / ".env"]
    for env_path in env_paths:
        if env_path.is_file():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip("'\"")
                os.environ.setdefault(key, val)
            break


_load_env_file()


class Settings:
    """Central application configuration settings."""

    @property
    def postgres_host(self) -> str:
        return os.getenv("POSTGRES_HOST", "localhost")

    @property
    def postgres_port(self) -> int:
        return int(os.getenv("POSTGRES_PORT", "5432"))

    @property
    def postgres_user(self) -> str:
        return os.getenv("POSTGRES_USER", "coordinator")

    @property
    def postgres_password(self) -> str:
        return os.getenv("POSTGRES_PASSWORD", "your_secure_password")

    @property
    def postgres_db(self) -> str:
        return os.getenv("POSTGRES_DB", "coordinator_db")

    @property
    def readyset_host(self) -> str:
        return os.getenv("READYSET_HOST", "localhost")

    @property
    def readyset_port(self) -> int:
        return int(os.getenv("READYSET_PORT", "5433"))

    @property
    def use_readyset(self) -> bool:
        val = os.getenv("USE_READYSET", "true").lower()
        return val in ("true", "1", "yes")

    @property
    def e621_username(self) -> str:
        return os.getenv("E621_USERNAME") or os.getenv("VITE_E621_APP_AUTHOR") or "anonymous"

    @property
    def version(self) -> str:
        return "0.3 Alpha"

    @property
    def app_env(self) -> str:
        return os.getenv("APP_ENV", "dev")

    @property
    def user_agent(self) -> str:
        return f"P.A.C.K. Coordinator (Backend) ({self.version} - {self.app_env}) (by {self.e621_username})"


settings = Settings()
