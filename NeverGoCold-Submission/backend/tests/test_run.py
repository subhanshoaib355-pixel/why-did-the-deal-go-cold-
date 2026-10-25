import json
import os
from pathlib import Path
import threading
import tempfile
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import run


class RunApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), run.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/run"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        with run.CACHE_LOCK:
            run.CACHE.clear()
            for event, _ in run.INFLIGHT.values():
                event.set()
            run.INFLIGHT.clear()

    def post(self, payload):
        request = Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        return response.status, json.loads(response.read().decode("utf-8"))

    def test_refresh_bypasses_cache_and_normal_request_reuses_it(self):
        calls = []

        def orchestrate(deal):
            calls.append(deal)
            return 0, json.dumps({"deal_id": deal, "run": len(calls)}), ""

        with patch("run.run_orchestrator", side_effect=orchestrate):
            first_status, first = self.post({"deal_id": "D001"})
            cached_status, cached = self.post({"deal_id": "D001"})
            refreshed_status, refreshed = self.post({"deal_id": "D001", "refresh": True})

        self.assertEqual((first_status, cached_status, refreshed_status), (200, 200, 200))
        self.assertEqual(first["run"], 1)
        self.assertEqual(cached["run"], 1)
        self.assertEqual(refreshed["run"], 2)
        self.assertEqual(calls, ["D001", "D001"])

    def test_rejects_invalid_request_fields(self):
        bad_refresh_status, _ = self.post({"deal_id": "D001", "refresh": "true"})
        bad_deal_status, _ = self.post({"deal_id": ["D001"]})

        self.assertEqual(bad_refresh_status, 400)
        self.assertEqual(bad_deal_status, 400)

    def test_refresh_waiting_on_normal_run_still_runs_fresh(self):
        _, should_run = run.cached_payload("D001")
        self.assertTrue(should_run)
        result = {}

        def request_refresh():
            result["claim"] = run.cached_payload("D001", refresh=True)

        waiter = threading.Thread(target=request_refresh)
        waiter.start()
        run.store_payload("D001", {"deal_id": "D001", "run": 1})
        waiter.join(timeout=2)

        self.assertFalse(waiter.is_alive())
        self.assertEqual(result["claim"], (None, True))
        run.release_inflight("D001")

    def test_load_dotenv_preserves_existing_environment(self):
        name = "NEVERGOCOLD_DOTENV_TEST"
        quoted_name = "NEVERGOCOLD_QUOTED_TEST"
        os.environ.pop(quoted_name, None)
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(
                f'{name}=from-file\n{quoted_name}="quoted value"\n',
                encoding="utf-8",
            )
            with patch.object(run, "ROOT", Path(directory)), patch.dict(os.environ, {name: "from-shell"}):
                run.load_dotenv()
                self.assertEqual(os.environ[name], "from-shell")
                self.assertEqual(os.environ[quoted_name], "quoted value")


if __name__ == "__main__":
    unittest.main()
