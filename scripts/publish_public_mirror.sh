#!/usr/bin/env bash
# Publish the prepared history and remove only legacy mirror bookkeeping refs.
set -euo pipefail
: "${1:?Usage: publish_public_mirror.sh prepared-repository destination}"
: "${2:?Usage: publish_public_mirror.sh prepared-repository destination}"
prepared="$1"
destination="$2"
git -C "$prepared" rev-parse --verify refs/heads/main >/dev/null

refspecs=()
local_refs="$(git -C "$prepared" for-each-ref --format='%(refname)')"
while IFS= read -r ref; do
  case "$ref" in
    refs/heads/main|refs/tags/custody-full) refspecs+=("$ref:$ref") ;;
    *) echo "Ref is not approved for publication: $ref" >&2; exit 1 ;;
  esac
done <<< "$local_refs"

# The old --mirror workflow exported these namespaces. Remove their remote
# copies too; leave ordinary branches, release tags and GitHub PR refs alone.
legacy_refs="$(git ls-remote --refs "$destination" 'refs/original/*' 'refs/remotes/*')"
while IFS=$'\t' read -r oid ref; do
  [ -n "$ref" ] || continue
  case "$ref" in
    refs/original/*|refs/remotes/*) refspecs+=(":$ref") ;;
    *) echo "Unexpected legacy ref: $ref" >&2; exit 1 ;;
  esac
done <<< "$legacy_refs"

git -C "$prepared" push --atomic --force "$destination" "${refspecs[@]}"
