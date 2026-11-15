"""Security regression tests for the local SharedChat bridge."""
import importlib.util
import pathlib
import sys
import types
import unittest
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "services" / "sharedchat-bridge" / "bridge.py"

# requests is only used for outbound calls; stub it so this test needs no pip install.
_previous_requests = sys.modules.get("requests")
sys.modules["requests"] = types.SimpleNamespace(post=None)
try:
    spec = importlib.util.spec_from_file_location("dsh_sharedchat_bridge", BRIDGE)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
finally:
    if _previous_requests is None:
        sys.modules.pop("requests", None)
    else:
        sys.modules["requests"] = _previous_requests


class BridgeSecurityTest(unittest.TestCase):
    def test_loopback_bindings_are_safe_without_a_key(self):
        for host in ("127.0.0.1", "::1", "localhost"):
            with self.subTest(host=host):
                self.assertTrue(bridge.is_loopback_host(host))

    def test_wildcard_and_lan_bindings_are_not_loopback(self):
        for host in ("0.0.0.0", "::", "192.168.1.10", "example.com"):
            with self.subTest(host=host):
                self.assertFalse(bridge.is_loopback_host(host))

    def test_authentication_is_required_when_a_key_is_configured(self):
        old = bridge.LOCAL_KEY
        bridge.LOCAL_KEY = "test-secret"
        try:
            self.assertFalse(bridge.Handler._auth_ok(SimpleNamespace(headers={})))
            self.assertFalse(bridge.Handler._auth_ok(SimpleNamespace(
                headers={"Authorization": "Bearer wrong"})))
            self.assertTrue(bridge.Handler._auth_ok(SimpleNamespace(
                headers={"Authorization": "Bearer test-secret"})))
            self.assertTrue(bridge.Handler._auth_ok(SimpleNamespace(
                headers={"x-api-key": "test-secret"})))
        finally:
            bridge.LOCAL_KEY = old


if __name__ == "__main__":
    unittest.main()
