"""Regression tests for the custom dual-ABI release workflow contract."""

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "custom-release.yml"


class CustomReleaseWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_shared_build_number_is_generated_once(self):
        self.assertIn("build_number: ${{ steps.number.outputs.build_number }}", self.text)
        self.assertIn('echo "build_number=$(python3 tooling/build_number.py)" >> "$GITHUB_OUTPUT"', self.text)

    def test_both_abis_consume_the_same_build_number(self):
        for flavor in ("arm64", "arm32"):
            with self.subTest(flavor=flavor):
                self.assertIn(f'tooling/build-apk.sh -f {flavor} -n "$BUILD_NUMBER"', self.text)
        self.assertEqual(
            self.text.count("BUILD_NUMBER: ${{ needs.prepare.outputs.build_number }}"),
            2,
        )

    def test_both_apks_are_checked_against_the_shared_version_code(self):
        self.assertEqual(self.text.count("grep -F \\"versionCode='$BUILD_NUMBER'\\""), 2)

    def test_release_waits_for_both_abi_artifacts(self):
        self.assertIn("needs: [prepare, arm64, arm32]", self.text)
        self.assertIn("needs.arm64.result == 'success' && needs.arm32.result == 'success'", self.text)
        self.assertIn("arm64 artifact missing; refusing partial release", self.text)
        self.assertIn("arm32 artifact missing; refusing partial release", self.text)

    def test_release_tag_is_unique_per_workflow_run(self):
        self.assertIn('tag="custom-${ver}-${GITHUB_RUN_ID}"', self.text)


if __name__ == "__main__":
    unittest.main()
