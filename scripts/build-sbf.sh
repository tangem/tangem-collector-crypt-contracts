#!/usr/bin/env bash
# Build the vault with a PINNED platform-tools, and fail on the SBF stack warning.
#
#   bash scripts/build-sbf.sh [extra cargo-build-sbf args]
#
# Two traps live here, and both exit 0 while writing a .so that is broken:
#
# 1. platform-tools v1.54 — the default in solana-cli 4.2.x — emits a
#    tangem_gacha_vault.so that faults at runtime with "Access violation in
#    unknown section at address 0x32 of size 1" after 411 compute units. That is
#    before any handler body runs, so no program log points at the cause; what
#    you see is all eight caps.rs tests failing in init_vault with
#    ProgramFailedToComplete. v1.52 is what this suite is green against, on both
#    sides of the cc_buyback integration.
#
# 2. A generated try_accounts frame over the 4 KB SBF stack is only a WARNING.
#    In that artifact the spilled bytes corrupt deserialization — the OpenPack
#    overflow made config.paused read true from a zero byte and killed every
#    spin with error 6000.
#
# rust-toolchain.toml pins the host compiler. This pins the SBF toolchain, which
# was the half still floating, and is the same guard CC runs over cc_buyback.
set -euo pipefail
cd "$(dirname "$0")/.."

TOOLS_VERSION="${TOOLS_VERSION:-v1.52}"
LOG="${LOG:-build.log}"

cargo-build-sbf --tools-version "$TOOLS_VERSION" "$@" 2>&1 | tee "$LOG"

if grep -qE "Stack offset of [0-9]+ exceeded max offset" "$LOG"; then
  echo
  echo "BUILD REJECTED — SBF stack overflow:"
  grep -E "Stack offset of [0-9]+ exceeded max offset" "$LOG" | sed 's/^/  /'
  echo
  echo "The .so was still written and WILL fault at runtime. Box the typed"
  echo "accounts in the named Accounts struct and rebuild."
  exit 1
fi

echo
echo "SBF stack OK — platform-tools $TOOLS_VERSION"
echo "Next: STACK_LOG=$LOG scripts/check_fixtures.sh && cargo test -p tangem-gacha-vault --tests"
