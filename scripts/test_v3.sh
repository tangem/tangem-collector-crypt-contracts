#!/usr/bin/env bash
# Execute the TypeScript integration suite against the exact v3 artifact.
# Uses an isolated local validator; no devnet/mainnet transactions are sent.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${AGAVE_BIN:?Set AGAVE_BIN to the bin directory of a compatible Agave release}"
: "${ANCHOR_WALLET:?Set ANCHOR_WALLET to a keypair used only as the local test payer}"
: "${V3_BUILD_LOG:?Set V3_BUILD_LOG to the completed v3 build log}"
artifact="${VAULT_SBF_PATH:-$PWD/target/deploy-v3/tangem_gacha_vault.so}"
python3 scripts/check_build.py --binary "$artifact" --log "$V3_BUILD_LOG" --expect-sbpf 3
python3 scripts/verify_interface.py

program_id="$(node -p 'require("./idl/tangem_gacha_vault.json").address')"
authority="$("$AGAVE_BIN/solana-keygen" pubkey "$ANCHOR_WALLET")"
"$AGAVE_BIN/solana-test-validator" --version
run_dir="$(mktemp -d "${TMPDIR:-/tmp}/tangem-v3-test.XXXXXX")"
validator_pid=""
cleanup() {
  if [ -n "$validator_pid" ]; then
    kill "$validator_pid" 2>/dev/null || true
    wait "$validator_pid" 2>/dev/null || true
  fi
  mkdir -p target
  cp "$run_dir/validator.log" target/v3-validator.log 2>/dev/null || true
  cp "$run_dir/ledger/validator.log" target/v3-validator-runtime.log 2>/dev/null || true
  rm -rf "$run_dir"
}
trap cleanup EXIT
export ANCHOR_PROVIDER_URL="http://127.0.0.1:18999"
"$AGAVE_BIN/solana-test-validator" \
  --ledger "$run_dir/ledger" --bind-address 127.0.0.1 \
  --rpc-port 18999 --faucet-port 19900 \
  --gossip-port 20001 --dynamic-port-range 20000-20100 \
  --upgradeable-program "$program_id" "$artifact" "$authority" \
  > "$run_dir/validator.log" 2>&1 &
validator_pid=$!

# Bound startup wait. The program dump below independently checks the actual
# executable served by this RPC before any integration tests can pass.
ready=false
for attempt in $(seq 1 120); do
  if ! kill -0 "$validator_pid" 2>/dev/null; then
    cat "$run_dir/validator.log"
    tail -40 "$run_dir/ledger/validator.log" 2>/dev/null || true
    exit 1
  fi
  if node -e 'fetch(process.env.ANCHOR_PROVIDER_URL, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getHealth"}), signal:AbortSignal.timeout(500)}).then(r=>r.json()).then(r=>process.exit(r.result==="ok"?0:1)).catch(()=>process.exit(1))'; then
    ready=true
    break
  fi
  sleep 0.25
done
if [ "$ready" != true ]; then
  cat "$run_dir/validator.log"
  echo "Local validator did not become ready" >&2
  exit 1
fi

"$AGAVE_BIN/solana" --url "$ANCHOR_PROVIDER_URL" --commitment confirmed \
  program dump "$program_id" "$run_dir/deployed.so"
python3 - "$artifact" "$run_dir/deployed.so" <<'PY'
import hashlib
from pathlib import Path
import sys
expected, actual = (Path(p).read_bytes() for p in sys.argv[1:])
if actual[:len(expected)] != expected or any(actual[len(expected):]):
    raise SystemExit("Local validator executable does not match the selected artifact")
print(f"Local executable verified: sha256 {hashlib.sha256(expected).hexdigest()}")
PY

yarn run ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.ts'
