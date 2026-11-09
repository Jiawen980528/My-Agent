"""The separate MyAgent process consumes the shared gateway, not provider keys."""
import importlib
import importlib.util
import sys
from pathlib import Path


def service_modules():
    root = Path(__file__).resolve().parents[2] / 'external/myagent-service/app'
    name = 'myagent_shared_test_service'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, root / '__init__.py', submodule_search_locations=[str(root)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[name] = package
        spec.loader.exec_module(package)
    return importlib.import_module(name + '.config'), importlib.import_module(name + '.agent')


def test_myagent_shared_configuration_never_uses_legacy_provider_key(monkeypatch):
    config, agent = service_modules()
    monkeypatch.setenv('SHARED_AI_ENABLED', '1')
    monkeypatch.setenv('TICKFLOW_BRIDGE_TOKEN', 'internal-service-token')
    monkeypatch.setenv('TICKFLOW_BRIDGE_URL', 'http://tick-stock-panel:3018')
    profiles = config.settings.providers()
    assert list(profiles) == ['shared']
    assert config.settings.configured_provider_names() == ('shared',)
    assert profiles['shared'].base_url == 'http://tick-stock-panel:3018/api/bridge/ai/v1'
    captured = {}
    def client(**kwargs):
        captured.update(kwargs)
        return 'client'
    monkeypatch.setattr(agent, 'OpenAI', client)
    assert agent.get_client() == 'client'
    assert captured['api_key'] == 'internal-service-token'
    assert captured['base_url'] == profiles['shared'].base_url
    assert 'shared' in agent.VISION_PROVIDERS


def test_legacy_standalone_configuration_is_unchanged(monkeypatch):
    config, _ = service_modules()
    monkeypatch.delenv('SHARED_AI_ENABLED', raising=False)
    assert 'shared' not in config.settings.providers()
    assert 'deepseek' in config.settings.providers()
