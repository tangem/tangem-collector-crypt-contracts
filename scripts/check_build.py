#!/usr/bin/env python3
"""Check a completed SBF build; this is not an audit or deployment approval."""

import argparse
import hashlib
from pathlib import Path
import re
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--log", type=Path, required=True, help="Complete successful anchor build log")
parser.add_argument("--binary", type=Path, default=ROOT / "target/deploy/tangem_gacha_vault.so")
parser.add_argument("--expect-sbpf", type=int, choices=(0, 1, 2, 3), required=True)
args = parser.parse_args()

try:
    log = args.log.read_text(errors="replace")
    binary = args.binary.read_bytes()
    if re.search(r"Stack offset|stack frame.*exceed|^error(?:\[|:)", log, re.I | re.M):
        raise ValueError("Build log contains a compiler error or SBF stack overflow")
    if "Finished" not in log:
        raise ValueError("Build log does not record a completed build")
    if len(binary) < 64 or binary[:6] != b"\x7fELF\x02\x01":
        raise ValueError("Expected a little-endian ELF64 binary")
    elf_type, machine = struct.unpack_from("<HH", binary, 16)
    if elf_type != 3 or machine not in (247, 263):
        raise ValueError("Expected a BPF/SBPF shared-object ELF, not a host binary")
    flags = struct.unpack_from("<I", binary, 48)[0]
    if flags != args.expect_sbpf:
        raise ValueError(f"sBPF ELF flags {flags}, expected {args.expect_sbpf}")
    inputs = [ROOT / name for name in (
        "programs/tangem-gacha-vault/src/lib.rs",
        "programs/tangem-gacha-vault/Cargo.toml", "Cargo.toml", "Cargo.lock",
    )]
    if any(p.stat().st_mtime_ns > args.binary.stat().st_mtime_ns for p in inputs):
        raise ValueError("Binary predates a build input; rebuild before testing or deploying")
    # cargo-build-sbf copies the final ELF after Cargo prints "Finished";
    # the completed log may legitimately precede that copy by a short time.
    if any(p.stat().st_mtime_ns > args.log.stat().st_mtime_ns for p in inputs):
        raise ValueError("Build log predates a build input")
    print(f"Build checks passed: {len(binary)} bytes, sBPF v{flags}, sha256 {hashlib.sha256(binary).hexdigest()}")
except (OSError, ValueError) as error:
    print(f"Build check failed: {error}", file=sys.stderr)
    sys.exit(1)
