"""Exercise publication against local Git repositories, without GitHub/SSH."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "public_mirror", Path(__file__).resolve().parents[1] / "prepare_public_mirror.py"
)
MIRROR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIRROR)


class PublicMirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tangem-mirror-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git(self.source, "init", "--initial-branch=main")
        self.git(self.source, "config", "user.name", "Private Commit Author")
        self.git(self.source, "config", "user.email", "private@example.test")
        self.git(self.source, "config", "commit.gpgsign", "false")
        self.git(self.source, "config", "tag.gpgsign", "false")
        (self.source / ".github").mkdir()
        (self.source / ".github/internal.txt").write_text("INTERNAL_WORKFLOW_MARKER\n")
        (self.source / ".gitignore").write_text("keys/\n")
        (self.source / "README.md").write_text("public content\n")
        self.commit("public ancestor")
        self.ancestor = self.git(self.source, "rev-parse", "HEAD")
        self.git(self.source, "-c", "user.name=Private Tag Author", "-c",
                 "user.email=tagger@example.test", "tag", "-a", "custody-full", "-m", "Full custody archive")
        (self.source / "README.md").write_text("updated public content\n")
        self.commit("public head")
        self.git(self.source, "update-ref", "refs/original/refs/heads/main", "HEAD")
        self.git(self.source, "checkout", "-b", "private-feature")
        (self.source / "private.txt").write_text("PRIVATE_FEATURE_MARKER\n")
        self.commit("private feature")
        self.private_commit = self.git(self.source, "rev-parse", "HEAD")
        self.git(self.source, "tag", "-a", "internal-only", "-m", "Do not publish")
        self.git(self.source, "checkout", "main")
        self.source_refs = self.git(self.source, "show-ref")

    def git(self, repo, *args):
        return subprocess.run(
            ["git", "-C", str(repo), *args], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        ).stdout.strip()

    def commit(self, message):
        self.git(self.source, "add", ".")
        self.git(self.source, "commit", "-m", message)

    def assert_public_history(self, repo, expected_refs):
        self.assertEqual(set(self.git(repo, "for-each-ref", "--format=%(refname)").splitlines()), set(expected_refs))
        public_refs = [ref for ref in expected_refs if ref in ("refs/heads/main", "refs/tags/custody-full")]
        for commit in self.git(repo, "rev-list", *public_refs).splitlines():
            self.assertNotEqual(commit, self.private_commit)
            self.assertEqual(self.git(repo, "show", "-s", "--format=%an <%ae>%n%cn <%ce>", commit),
                             "tangem-service <gitservice@tangem.com>\ntangem-service <gitservice@tangem.com>")
            paths = self.git(repo, "ls-tree", "-r", "--name-only", commit).splitlines()
            self.assertFalse(any(p == ".gitignore" or p.startswith(".github/") or p == "private.txt" for p in paths))
        self.assertNotEqual(self.git(repo, "show", "refs/heads/main:README.md"), "")

    def test_publication_sanitizes_history_and_tagger_without_exporting_other_refs(self):
        remote = self.root / "remote.git"
        remote.mkdir()
        self.git(remote, "init", "--bare", "--initial-branch=main")
        self.git(self.source, "push", str(remote),
                 "refs/heads/main:refs/original/refs/heads/main",
                 "refs/heads/private-feature:refs/remotes/origin/private-feature",
                 "refs/heads/private-feature:refs/heads/dependabot/synthetic",
                 "refs/heads/private-feature:refs/pull/1/head")
        preserved_refs = ["refs/heads/dependabot/synthetic", "refs/pull/1/head"]
        previous_refs = None
        for run in range(2):
            prepared = self.root / f"prepared-{run}.git"
            refs = MIRROR.prepare(self.source, prepared)
            self.assertEqual(refs, ["refs/heads/main", "refs/tags/custody-full"])
            self.assert_public_history(prepared, refs)
            # Execute the actual publishing script, targeting only a local bare
            # repository. Legacy refs must disappear; independent refs survive.
            subprocess.run(["bash", str(Path(__file__).resolve().parents[1] / "publish_public_mirror.sh"),
                            str(prepared), str(remote)], check=True, capture_output=True)
            self.assert_public_history(remote, refs + preserved_refs)
            for ref in preserved_refs:
                self.assertEqual(self.git(remote, "rev-parse", ref), self.private_commit)
            tag = self.git(remote, "cat-file", "tag", "refs/tags/custody-full")
            self.assertIn("tagger tangem-service <gitservice@tangem.com> ", tag)
            self.assertNotIn("Private Tag Author", tag)
            self.assertNotIn("tagger@example.test", tag)
            self.assertTrue(tag.endswith("Full custody archive"))
            self.assertNotEqual(self.git(remote, "rev-parse", "custody-full^{commit}"), self.ancestor)
            self.assertEqual(self.git(remote, "show", "custody-full:README.md"), "public content")
            current_refs = self.git(remote, "show-ref")
            if previous_refs is not None:
                self.assertEqual(current_refs, previous_refs)
            previous_refs = current_refs
        self.assertEqual(self.git(self.source, "show-ref"), self.source_refs)

    def test_tag_not_merged_into_main_is_not_published(self):
        self.git(self.source, "tag", "-f", "-a", "custody-full", self.private_commit, "-m", "Unmerged")
        prepared = self.root / "prepared.git"
        refs = MIRROR.prepare(self.source, prepared)
        self.assertEqual(refs, ["refs/heads/main"])
        self.assert_public_history(prepared, refs)

    def test_absent_archive_tag_still_prepares_main(self):
        self.git(self.source, "tag", "-d", "custody-full")
        prepared = self.root / "prepared.git"
        refs = MIRROR.prepare(self.source, prepared)
        self.assertEqual(refs, ["refs/heads/main"])
        self.assert_public_history(prepared, refs)

    def test_lightweight_archive_tag_is_retargeted_to_sanitized_commit(self):
        self.git(self.source, "tag", "-d", "custody-full")
        self.git(self.source, "tag", "custody-full", self.ancestor)
        prepared = self.root / "prepared.git"
        refs = MIRROR.prepare(self.source, prepared)
        self.assert_public_history(prepared, refs)
        self.assertEqual(self.git(prepared, "cat-file", "-t", "custody-full"), "commit")
        self.assertEqual(self.git(prepared, "show", "custody-full:README.md"), "public content")

    def test_existing_destination_is_refused_without_mutation(self):
        prepared = self.root / "prepared.git"
        prepared.mkdir()
        marker = prepared / "existing-content"
        marker.write_text("do not change")
        with self.assertRaises(FileExistsError):
            MIRROR.prepare(self.source, prepared)
        self.assertEqual(marker.read_text(), "do not change")

    def test_publication_refuses_unexpected_local_refs(self):
        prepared = self.root / "prepared.git"
        MIRROR.prepare(self.source, prepared)
        self.git(prepared, "update-ref", "refs/original/refs/heads/main", "refs/heads/main")
        remote = self.root / "remote.git"
        remote.mkdir()
        self.git(remote, "init", "--bare", "--initial-branch=main")
        result = subprocess.run(
            ["bash", str(Path(__file__).resolve().parents[1] / "publish_public_mirror.sh"), str(prepared), str(remote)],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Ref is not approved for publication", result.stderr)
        self.assertEqual(self.git(remote, "for-each-ref"), "")


if __name__ == "__main__":
    unittest.main()
