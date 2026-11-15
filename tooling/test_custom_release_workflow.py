"""Regression tests for the custom dual-ABI release workflow contract."""

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "custom-release.yml"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
GOLDENS_WORKFLOW = ROOT / ".github" / "workflows" / "goldens.yml"


class CustomReleaseWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.ci = CI_WORKFLOW.read_text(encoding="utf-8")
        cls.goldens = GOLDENS_WORKFLOW.read_text(encoding="utf-8")

    def test_shared_build_number_and_default_app_version_are_prepared_once(self):
        self.assertIn("app_version: ${{ steps.meta.outputs.app_version }}", self.text)
        self.assertIn("build_number: ${{ steps.meta.outputs.build_number }}", self.text)
        self.assertIn('Path("app/pubspec.yaml").read_text()', self.text)
        self.assertIn('echo "build_number=$(python3 tooling/build_number.py)" >> "$GITHUB_OUTPUT"', self.text)
        self.assertEqual(self.text.count("needs.prepare.outputs.app_version"), 2)
        self.assertNotIn("ver=1.0.17", self.text)

    def test_both_abis_consume_the_same_build_number(self):
        for flavor in ("arm64", "arm32"):
            with self.subTest(flavor=flavor):
                self.assertIn(f'tooling/build-apk.sh -f {flavor} -n "$BUILD_NUMBER"', self.text)
        self.assertEqual(
            self.text.count("BUILD_NUMBER: ${{ needs.prepare.outputs.build_number }}"),
            4,  # build and manifest verification steps for both ABIs
        )
        self.assertEqual(self.text.count("python3 tooling/build_number.py"), 1)

    def test_both_apks_are_checked_against_the_shared_version_code(self):
        self.assertEqual(self.text.count('grep -F "versionCode='), 2)

    def test_release_waits_for_both_abi_artifacts(self):
        self.assertIn("needs: [prepare, arm64, arm32]", self.text)
        self.assertIn("needs.arm64.result == 'success' && needs.arm32.result == 'success'", self.text)
        self.assertIn("arm64 artifact missing; refusing partial release", self.text)
        self.assertIn("arm32 artifact missing; refusing partial release", self.text)

    def test_push_events_are_received_then_filtered_by_job_branch_guards(self):
        # Receive push events first; apply the supported branch scope in jobs so GitHub
        # cannot silently miss the nested custom/* branch pattern at event filtering.
        self.assertIn("  push:\\n  workflow_dispatch:", self.ci)
        self.assertIn("github.ref == 'refs/heads/main'", self.ci)
        self.assertIn("startsWith(github.ref, 'refs/heads/custom/')", self.ci)
        self.assertIn("startsWith(github.ref, 'refs/heads/work/')", self.ci)
        self.assertIn("  push:\\n  workflow_dispatch:", self.goldens)
        self.assertIn("startsWith(github.ref, 'refs/heads/custom/')", self.goldens)
        self.assertIn("startsWith(github.ref, 'refs/heads/work/')", self.goldens)
        self.assertIn("  push:\\n\\npermissions:", self.text)
        self.assertIn("startsWith(github.ref, 'refs/heads/custom/')", self.text)
        self.assertIn("startsWith(github.ref, 'refs/heads/work/')", self.text)
        self.assertIn("  workflow_dispatch:", self.text)

    def test_custom_releases_are_serialized(self):
        self.assertIn("group: dsh-go-custom-release", self.text)
        self.assertIn("cancel-in-progress: false", self.text)

    def test_release_tag_is_unique_per_workflow_run(self):
        self.assertIn('tag="custom-${ver}-${GITHUB_RUN_ID}"', self.text)


if __name__ == "__main__":
    unittest.main()
