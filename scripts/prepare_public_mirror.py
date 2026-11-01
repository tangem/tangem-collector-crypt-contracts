#!/usr/bin/env python3
"""Prepare an isolated, sanitized main/tag repository; never publish it."""

import argparse
import os
from pathlib import Path
import re
import subprocess


PUBLIC_BRANCH = "refs/heads/main"
# Publishing another tag requires an explicit addition here. It must also be
# reachable from main, so an unmerged/private branch cannot become public.
PUBLIC_TAGS = ("refs/tags/custody-full",)
IDENTITY = b"tangem-service <gitservice@tangem.com>"


def git(repo, *args, data=None, check=True):
    return subprocess.run(
        ["git", "-C", str(repo), *args], input=data, check=check,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={**os.environ, "FILTER_BRANCH_SQUELCH_WARNING": "1"},
    )


def prepare(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    refs = [PUBLIC_BRANCH]
    git(source, "rev-parse", "--verify", PUBLIC_BRANCH)
    for ref in PUBLIC_TAGS:
        if git(source, "show-ref", "--verify", "--quiet", ref, check=False).returncode:
            continue
        ancestry = git(source, "merge-base", "--is-ancestor", f"{ref}^{{commit}}", PUBLIC_BRANCH, check=False)
        if ancestry.returncode == 1:
            continue
        ancestry.check_returncode()
        refs.append(ref)

    # Never rewrite the checkout or inherit remotes, private branches or backup
    # refs. Refuse an existing output directory rather than reuse stale refs.
    destination.mkdir(parents=True, exist_ok=False)
    git(destination, "init", "--bare", "--initial-branch=main")
    git(destination, "fetch", "--no-tags", str(source), *(f"{ref}:{ref}" for ref in refs))
    git(destination, "filter-branch",
        "--env-filter", 'export GIT_AUTHOR_NAME="tangem-service" GIT_AUTHOR_EMAIL="gitservice@tangem.com" '
                        'GIT_COMMITTER_NAME="tangem-service" GIT_COMMITTER_EMAIL="gitservice@tangem.com"',
        "--index-filter", "git rm -r --cached --ignore-unmatch -- .github .gitignore",
        "--tag-name-filter", "cat", "--", *refs)

    # filter-branch rewrites tag targets but preserves annotated-tag authors.
    # Keep the annotation/date, replace the tagger, and discard signatures that
    # cannot authenticate a rewritten object (PGP, SSH or X.509).
    for ref in refs[1:]:
        if git(destination, "cat-file", "-t", ref).stdout.strip() != b"tag":
            continue
        raw = git(destination, "cat-file", "tag", ref).stdout
        header, separator, message = raw.partition(b"\n\n")
        header, count = re.subn(
            rb"(?m)^tagger .* <[^>]*> (-?\d+ [+-]\d{4})$",
            lambda match: b"tagger " + IDENTITY + b" " + match[1], header,
        )
        if not separator or count != 1:
            raise ValueError(f"Malformed annotated tag: {ref}")
        message = re.split(rb"(?m)^-----BEGIN (?:PGP SIGNATURE|SSH SIGNATURE|SIGNED MESSAGE)-----", message)[0]
        oid = git(destination, "mktag", data=header + separator + message).stdout.decode().strip()
        git(destination, "update-ref", ref, oid)

    for ref in git(destination, "for-each-ref", "--format=%(refname)", "refs/original").stdout.decode().splitlines():
        git(destination, "update-ref", "-d", ref)
    actual = git(destination, "for-each-ref", "--format=%(refname)").stdout.decode().splitlines()
    if set(actual) != set(refs):
        raise ValueError(f"Unexpected public refs: {actual}")
    return refs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, help="New directory for the sanitized bare repository")
    args = parser.parse_args()
    try:
        print("Prepared public refs: " + ", ".join(prepare(args.source, args.destination)))
    except subprocess.CalledProcessError as error:
        parser.exit(1, error.stderr.decode(errors="replace"))
    except (OSError, ValueError) as error:
        parser.exit(1, f"Mirror preparation failed: {error}\n")
