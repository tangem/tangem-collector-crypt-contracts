#!/usr/bin/env python3
"""Offline Day 1 ABI checks against the published purchase_pack interface."""

import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    "initialize_config", "update_config", "init_vault", "update_vault",
    "close_vault", "purchase_pack", "withdraw_token", "withdraw_sol", "close_token_account",
}


def strip_docs(value):
    if isinstance(value, dict):
        return {key: strip_docs(item) for key, item in value.items() if key != "docs"}
    if isinstance(value, list):
        return [strip_docs(item) for item in value]
    return value


def discriminator(namespace, name):
    return list(hashlib.sha256(f"{namespace}:{name}".encode()).digest()[:8])


def main():
    idl = json.loads((ROOT / "idl/tangem_gacha_vault.json").read_text())
    generated = json.loads((ROOT / "target/idl/tangem_gacha_vault.json").read_text())
    baseline = json.loads((ROOT / "tests/abi/purchase_pack_release.json").read_text())
    assert idl == generated, "Committed IDL differs from the generated IDL"
    instructions = {ix["name"]: ix for ix in idl["instructions"]}
    assert set(instructions) == EXPECTED, "Expected exactly the nine Day 1 instructions"
    for ix in baseline["instructions"]:
        assert strip_docs(instructions[ix["name"]]) == ix, f"User ABI changed: {ix['name']}"
    types = {t["name"]: t for t in idl["types"]}
    events = {event["name"]: event for event in idl["events"]}
    assert len(events) == 8, "Expected eight Day 1 events"
    for event in baseline["events"]:
        assert events[event["name"]] == event, f"Event discriminator changed: {event['name']}"
    for event_type in baseline["types"]:
        assert strip_docs(types[event_type["name"]]) == event_type, f"Event ABI changed: {event_type['name']}"
    assert idl["errors"] == baseline["errors"], "Retained error names/numbers/messages changed"
    for key, namespace in (("instructions", "global"), ("accounts", "account"), ("events", "event")):
        for item in idl[key]:
            assert item["discriminator"] == discriminator(namespace, item["name"]), item["name"]

    sizes = {"pubkey": 32, "u64": 8, "i64": 8, "u16": 2, "u8": 1, "bool": 1}
    for name, expected_size in (("Config", 174), ("Vault", 137)):
        fields = types[name]["type"]["fields"]
        size = 8 + sum(sizes[field["type"]] if isinstance(field["type"], str)
                       else sizes[field["type"]["array"][0]] * field["type"]["array"][1]
                       for field in fields)
        assert size == expected_size, f"{name} allocation changed: {size}"
        assert strip_docs(fields[-1]) == {"name": "_reserved", "type": {"array": ["u8", 32]}}, name

    source = (ROOT / "programs/tangem-gacha-vault/src/lib.rs").read_text()
    anchor = (ROOT / "Anchor.toml").read_text()
    readme = (ROOT / "README.md").read_text()
    assert f'declare_id!("{idl["address"]}")' in source, "Source/IDL program ID mismatch"
    assert anchor.count(f'"{idl["address"]}"') == 2, "Anchor/genesis program ID mismatch"
    assert idl["address"] in readme, "README program ID mismatch"

    # The internal integration guide is kept locally in some checkouts. Check
    # it when present, without making CI depend on an untracked/private file.
    doc_path = ROOT / "INTEGRATION.md"
    if doc_path.exists():
        doc = doc_path.read_text()
        headings = list(re.finditer(r"^### 5\.\d+[^\n]*`([a-z_]+)\([^`]*`[^\n]*$", doc, re.M))
        assert {m[1] for m in headings} == EXPECTED, "Integration guide instruction coverage"
        for index, match in enumerate(headings):
            end = headings[index + 1].start() if index + 1 < len(headings) else doc.find("\n## 6.", match.end())
            section = doc[match.end():end]
            accounts = re.findall(r"^\d+\) `([a-z_]+)`(?:\s*\(([^)]*)\))?", section, re.M)
            expected = instructions[match[1]]["accounts"]
            assert len(accounts) == len(expected), f"Guide account count: {match[1]}"
            for (name, flags), account in zip(accounts, expected):
                assert name == account["name"], f"Guide account order: {match[1]}/{name}"
                for flag, key in (("w", "writable"), ("s", "signer")):
                    assert bool(re.search(rf"\b{flag}\b", flags)) == bool(account.get(key)), f"Guide {match[1]}/{name}/{key}"
            assert str(instructions[match[1]]["discriminator"]) in section, f"Guide discriminator: {match[1]}"
        doc_errors = {int(code): name for code, name in re.findall(r"(60\d\d)\s+`(\w+)`", doc)}
        assert doc_errors == {e["code"]: e["name"] for e in idl["errors"]}, "Guide error codes"
        doc_events = {name: [f.strip() for f in fields.split(",")]
                      for name, fields in re.findall(r"`(\w+)\s*\{([^}]*)\}`", doc)}
        assert doc_events == {name: [f["name"] for f in types[name]["type"]["fields"]]
                              for name in events}, "Guide event fields"
        assert idl["address"] in doc, "Guide program ID mismatch"
    print("Interface checks passed: 9 instructions, 7 preserved user ABIs, 8 events, 15 stable errors, Config 174 B, Vault 137 B")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, ValueError, KeyError) as error:
        print(f"Interface check failed: {error}", file=sys.stderr)
        sys.exit(1)
