"""Application configuration. Secrets are read only from environment variables."""
import os
import json
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _integer(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _names(value: str) -> tuple[str, ...]:
    return tuple(item.strip().lower() for item in value.split(",") if item.strip())


@dataclass(frozen=True)
class ProviderConfig:
    """An OpenAI-compatible provider profile. Never serialize its API key."""
    name: str
    label: str
    api_key: str
    model: str
    base_url: str


@dataclass(frozen=True)
class Settings:
    # First configured provider is used; later configured providers are fallbacks.
    model_provider: str = os.getenv("MODEL_PROVIDER", "openai").strip().lower()
    model_fallback_providers: tuple[str, ...] = _names(os.getenv("MODEL_FALLBACK_PROVIDERS", ""))

    openai_api_key: str = os.getenv("OPENAI_API_KEY", "").strip()
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4.1-mini").strip()
    openai_base_url: str = os.getenv("OPENAI_BASE_URL", "").strip()
    deepseek_api_key: str = os.getenv("DEEPSEEK_API_KEY", "").strip()
    deepseek_model: str = os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip()
    dashscope_api_key: str = os.getenv("DASHSCOPE_API_KEY", "").strip()
    dashscope_model: str = os.getenv("DASHSCOPE_MODEL", "qwen-plus").strip()
    siliconflow_api_key: str = os.getenv("SILICONFLOW_API_KEY", "").strip()
    siliconflow_model: str = os.getenv("SILICONFLOW_MODEL", "Qwen/Qwen2.5-7B-Instruct").strip()
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "").strip()
    openrouter_model: str = os.getenv("OPENROUTER_MODEL", "openai/gpt-4.1-mini").strip()
    moonshot_api_key: str = os.getenv("MOONSHOT_API_KEY", "").strip()
    moonshot_model: str = os.getenv("MOONSHOT_MODEL", "moonshot-v1-8k").strip()
    provider_config_path: str = os.getenv("PROVIDER_CONFIG_PATH", "./data/providers.json")
    email_config_path: str = os.getenv("EMAIL_CONFIG_PATH", "./data/email_connections.json")
    uploads_path: str = os.getenv("UPLOADS_PATH", "./data/uploads")

    admin_token: str = os.getenv("ADMIN_TOKEN", "").strip()
    database_path: str = os.getenv("DATABASE_PATH", "./data/myagent.db")
    timezone: str = os.getenv("TIMEZONE", "Asia/Shanghai")
    model_timeout_seconds: int = _integer("MODEL_TIMEOUT_SECONDS", 45)
    max_model_calls: int = _integer("MAX_MODEL_CALLS_PER_TASK", 6)
    max_task_seconds: int = _integer("MAX_TASK_SECONDS", 90)
    max_task_cost_usd: float = float(os.getenv("MAX_TASK_COST_USD", "0.25"))
    retention_days: int = _integer("DATA_RETENTION_DAYS", 180)

    def _provider_store(self) -> dict:
        """Read locally managed provider settings; ignore a malformed file safely."""
        try:
            with open(self.provider_config_path, "r", encoding="utf-8") as handle:
                data=json.load(handle)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError, TypeError):
            return {}

    def providers(self) -> dict[str, ProviderConfig]:
        if os.getenv("SHARED_AI_ENABLED") == "1":
            base = os.getenv("TICKFLOW_BRIDGE_URL", "http://tick-stock-panel:3018").rstrip("/")
            key = os.getenv("TICKFLOW_BRIDGE_TOKEN", "").strip()
            return {"shared": ProviderConfig("shared", "全站统一 AI", key, "auto", base + "/api/bridge/ai/v1")}
        profiles = {
            "openai": ProviderConfig("openai", "OpenAI", self.openai_api_key, self.openai_model, self.openai_base_url),
            "deepseek": ProviderConfig("deepseek", "DeepSeek", self.deepseek_api_key, self.deepseek_model, "https://api.deepseek.com/v1"),
            "dashscope": ProviderConfig("dashscope", "通义千问（DashScope）", self.dashscope_api_key, self.dashscope_model, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "siliconflow": ProviderConfig("siliconflow", "硅基流动", self.siliconflow_api_key, self.siliconflow_model, "https://api.siliconflow.cn/v1"),
            "openrouter": ProviderConfig("openrouter", "OpenRouter", self.openrouter_api_key, self.openrouter_model, "https://openrouter.ai/api/v1"),
            "moonshot": ProviderConfig("moonshot", "Moonshot", self.moonshot_api_key, self.moonshot_model, "https://api.moonshot.cn/v1"),
        }
        saved = self._provider_store().get("providers", {})
        if not isinstance(saved, dict):
            return profiles
        for name, values in saved.items():
            if name not in profiles or not isinstance(values, dict):
                continue
            current = profiles[name]
            api_key = values.get("api_key", current.api_key)
            model = values.get("model", current.model)
            if isinstance(api_key, str) and isinstance(model, str):
                profiles[name] = ProviderConfig(current.name, current.label, api_key.strip(), model.strip(), current.base_url)
        return profiles

    def provider_order(self) -> tuple[str, ...]:
        known = self.providers()
        if "shared" in known:
            return ("shared",)
        result: list[str] = []
        saved_order = self._provider_store().get("order")
        requested = saved_order if isinstance(saved_order, list) else (self.model_provider, *self.model_fallback_providers)
        for name in requested:
            if name in known and name not in result:
                result.append(name)
        return tuple(result)

    def configured_provider_names(self) -> tuple[str, ...]:
        profiles = self.providers()
        return tuple(name for name in self.provider_order() if profiles[name].api_key)


settings = Settings()
