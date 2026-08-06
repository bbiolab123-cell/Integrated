#!/usr/bin/env python3
"""Build the fifth audited BioLab public-bootstrap iteration.

Iteration 5 promotes every iteration-4 holdout to training-only data, adds
source-grounded strict decision/measurement replays, and creates fresh unseen
validation and test groups. Model candidates are never used as labels.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


EXPECTED_ITERATION4_DATASET_SHA256 = (
    "423530e9aefdd14361b265f1ba0b86faf1baf7315385026f4f86e9fce82a37b7"
)
EXPECTED_ITERATION4_REVIEW_SHA256 = (
    "fdbf2c2c7e196370a3980e7fb4687fa80ddfef6ff272345d24d1343c124553f8"
)
EXPECTED_ITERATION4_GATE_REPORT_SHA256 = (
    "6edfc83b3e9fb2e113f379089874e0da66a386a159c1b354c9b724c48a7e4d82"
)
AUDITED_ITERATION4_FAILED_HASHES = (
    "28c4ff2dc43b85d021d864f2673c641a6feb7b6b2a17f521541b6194c071493a",
    "44a95b5591a579cb7bb8d6212ba6d3b424eba21ced497a0cfe04fc2b9c4197b9",
    "62df2793ac756ff2c7f7bc3c590449049f6f0bfe9c508ac654b080c41dd2e2c9",
    "6b043de67cc7f77f6311808a7768cce7c41f8d5061a34d5f1e5068a1f3203e5a",
    "842b7b4af552f13d1f759bd2603a58b8f68f0677d4ea15fe1235eec4f0608391",
    "87c0a97aca43915686b7792b3097868d7745a7f7bda7ec46f9d611659a6132bc",
    "9ccf14f9a997123443fa9773526adb85e8bffb8ee455ed91da57c538f309bf13",
    "da5365af06074dcd9da7b3b14ae4550aa43be0d5d49d09c2d3073ac55e24b99f",
    "df15188f31e215427e031591dd81dc085e68d003f21262e489a6d53db4fbffe4",
    "ef3fa13df8e8f5099748e6340d451bede37b967dcaae5cb27be72c4781973e98",
)
AUDITED_ITERATION4_REVIEW_SUMMARY = {
    "review_sha256": EXPECTED_ITERATION4_REVIEW_SHA256,
    "gate_report_sha256": EXPECTED_ITERATION4_GATE_REPORT_SHA256,
    "records": 20,
    "adapter_approval_count": 10,
    "adapter_rating_4_or_5_count": 10,
    "adapter_measurement_fidelity_count": 19,
    "adapter_privacy_pass_count": 20,
    "adapter_structured_count": 5,
    "adapter_structured_valid_count": 5,
    "failed_adapter_examples_promoted_for_correction": 10,
    "review_provenance": (
        "AI-assisted blind review performed by Codex at the BioLab owner's "
        "explicit request; not a human scientist/owner rating."
    ),
}
ITERATION_SCHEMA_VERSION = 4
TOTAL_EXAMPLES = 480
EXPECTED_SPLITS = Counter({"train": 440, "validation": 20, "test": 20})
STRICT_VARIANT_COUNTS = {
    "experiment_analysis": 12,
    "data_analysis": 7,
    "experiment_chat": 7,
    "experiment_comparison": 7,
    "project_chat": 7,
    "project_synthesis": 7,
    "general_chat": 7,
    "protocol_generation": 3,
    "sop_structuring": 3,
}
PROTOCOL_HOLDOUT_PATHS = {
    "validation": {
        "protocol_generation": (
            "markdown-output/ecis-data-analysis-for-stimulation-of-human-pulmon-dapt2dnn.md"
        ),
        "sop_structuring": (
            "markdown-output/protocol-of-a-systematic-review-with-meta-analysis-b4x6qxre.md"
        ),
    },
    "test": {
        "protocol_generation": (
            "markdown-output/secondary-data-analysis-creating-a-mycomap-project-cgqftvtn.md"
        ),
        "sop_structuring": (
            "markdown-output/extracorporeal-membrane-oxygenation-meta-analysis-bb3tiqnn.md"
        ),
    },
}
EXACTNESS_RULE = (
    "Iteration 5 exactness rule: Copy any quoted number character-for-character "
    "from the supplied source. If a value is ambiguous, omit it. Finish the "
    "response and never stop mid-sentence."
)
DECISION_RE = re.compile(r"^Decision: (yes|no|maybe)\.\s*(.*)$", re.DOTALL)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not import {name} from {path}.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_jsonl(path: Path) -> tuple[list[dict[str, Any]], bytes]:
    data = path.read_bytes()
    rows = [json.loads(line) for line in data.decode("utf-8").splitlines() if line.strip()]
    return rows, data


def concise_decision_target(target: str) -> str:
    match = DECISION_RE.match(target.strip())
    if not match:
        raise AssertionError("A decision replay target lacks the exact decision line.")
    decision, body = match.groups()
    body = " ".join(body.split())
    if not body:
        raise AssertionError("A decision replay target lacks an evidence paragraph.")
    if len(body) > 560:
        cut = max(body.rfind(". ", 0, 560), body.rfind("? ", 0, 560), body.rfind("! ", 0, 560))
        if cut >= 120:
            body = body[: cut + 1]
        else:
            body = body[:560].rsplit(" ", 1)[0].rstrip(" ,;:") + "."
    if body[-1] not in ".!?":
        body += "."
    return f"Decision: {decision}.\n\n{body}"


def iteration5_prompt(user_content: str) -> str:
    if EXACTNESS_RULE in user_content:
        return user_content
    return f"{user_content.rstrip()}\n\n{EXACTNESS_RULE}"


def build_strict_variants(
    builder,
    iteration3_builder,
    iteration4_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    variants: list[dict[str, Any]] = []
    parent_by_variant: dict[str, str] = {}
    existing_input_hashes = {row["input_hash"] for row in iteration4_rows}
    clean_sources = [
        row
        for row in iteration4_rows
        if "Response contract:" not in row["messages"][-2]["content"]
        and "Return valid JSON only" not in row["messages"][-2]["content"]
        and not row["messages"][-1]["content"].lstrip().startswith("{")
    ]
    for task, count in STRICT_VARIANT_COUNTS.items():
        candidates = sorted(
            (row for row in clean_sources if row["task_type"] == task),
            key=lambda row: sha256_text(
                f"biolab-iteration5-strict-source-v1:{row['example_hash']}"
            ),
        )
        eligible: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for original in candidates:
            old_user = original["messages"][-2]["content"]
            old_target = original["messages"][-1]["content"]
            if task == "experiment_analysis":
                user = iteration3_builder.strict_pubmed_prompt(old_user, structured=True)
                target = iteration3_builder.analysis_json_target(old_target)
            elif task in builder.PROTOCOL_TASKS:
                user = iteration3_builder.strict_protocol_prompt(old_user)
                target = iteration3_builder.protocol_json_target(
                    builder,
                    old_target,
                    f"iteration5-{original['example_hash']}",
                )
            else:
                user = iteration3_builder.strict_pubmed_prompt(old_user, structured=False)
                target = concise_decision_target(old_target)
            user = iteration5_prompt(user)
            if target.lstrip().startswith("{"):
                prompt = "\n".join([original["messages"][0]["content"], user])
                unsupported = iteration3_builder.unsupported_numbers(target, prompt)
                if unsupported:
                    continue
            variant = iteration3_builder.make_row(
                builder,
                task=task,
                split="train",
                user_content=user,
                assistant_content=target,
                group_hash=original["group_hash"],
            )
            if variant["input_hash"] in existing_input_hashes:
                continue
            eligible.append((original, variant))
        if len(eligible) < count:
            raise AssertionError(f"Not enough clean iteration-5 sources for {task}.")
        for original, variant in eligible[:count]:
            variants.append(variant)
            parent_by_variant[variant["example_hash"]] = original["example_hash"]
            existing_input_hashes.add(variant["input_hash"])
    if len(variants) != 60:
        raise AssertionError(f"Expected 60 strict variants, found {len(variants)}.")
    return variants, parent_by_variant


def rebuild_holdout_prompts(
    builder,
    iteration3_builder,
    rows: list[dict[str, Any]],
    manifest: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rebuilt_rows: list[dict[str, Any]] = []
    rebuilt_manifest: list[dict[str, Any]] = []
    for row, item in zip(rows, manifest, strict=True):
        rebuilt = iteration3_builder.make_row(
            builder,
            task=row["task_type"],
            split=row["split"],
            user_content=iteration5_prompt(row["messages"][-2]["content"]),
            assistant_content=row["messages"][-1]["content"],
            group_hash=row["group_hash"],
        )
        updated = dict(item)
        updated["example_hash"] = rebuilt["example_hash"]
        updated["response_contract_version"] = "iteration5_exact_measurement_complete_v1"
        rebuilt_rows.append(rebuilt)
        rebuilt_manifest.append(updated)
    return rebuilt_rows, rebuilt_manifest


def build_protocol_holdouts(
    builder,
    iteration2_builder,
    iteration3_builder,
    used_identifiers: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    builder.assert_pinned_revision(builder.CADUCEUS_REPO, builder.CADUCEUS_REVISION)
    rows: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    for split, task_paths in PROTOCOL_HOLDOUT_PATHS.items():
        for task, path in task_paths.items():
            if path in used_identifiers:
                raise AssertionError(f"Iteration-5 protocol holdout was already used: {path}")
            markdown_row, item = iteration2_builder.protocol_validation_row(builder, task, path)
            user = iteration5_prompt(
                iteration3_builder.strict_protocol_prompt(
                    markdown_row["messages"][-2]["content"]
                )
            )
            target = iteration3_builder.protocol_json_target(
                builder,
                markdown_row["messages"][-1]["content"],
                path,
            )
            row = iteration3_builder.make_row(
                builder,
                task=task,
                split=split,
                source_group=f"{builder.CADUCEUS_REPO}:{path}",
                user_content=user,
                assistant_content=target,
            )
            updated = dict(item)
            updated.update(
                {
                    "example_hash": row["example_hash"],
                    "split": split,
                    "response_contract": "StructuredProtocolSchema",
                    "response_contract_version": "iteration5_exact_measurement_complete_v1",
                }
            )
            rows.append(row)
            manifest.append(updated)
    if len(rows) != 4:
        raise AssertionError("Iteration-5 protocol holdout count failed.")
    return rows, manifest


def validate_review_inputs(review_path: Path | None, gate_report_path: Path | None) -> None:
    if review_path is not None:
        actual = sha256_bytes(review_path.read_bytes())
        if actual != EXPECTED_ITERATION4_REVIEW_SHA256:
            raise AssertionError(
                f"Iteration-4 review changed: expected {EXPECTED_ITERATION4_REVIEW_SHA256}, found {actual}."
            )
    if gate_report_path is not None:
        actual = sha256_bytes(gate_report_path.read_bytes())
        if actual != EXPECTED_ITERATION4_GATE_REPORT_SHA256:
            raise AssertionError(
                "Iteration-4 gate report changed: "
                f"expected {EXPECTED_ITERATION4_GATE_REPORT_SHA256}, found {actual}."
            )
        report = json.loads(gate_report_path.read_text(encoding="utf-8"))
        if report.get("release_accepted") or report.get("disposition") != "quarantined":
            raise AssertionError("Iteration-4 gate report is not the quarantined result.")


def build_iteration(
    builder,
    iteration2_builder,
    iteration3_builder,
    iteration4_builder,
    parent_rows: list[dict[str, Any]],
    parent_manifest: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    available_hashes = {row["example_hash"] for row in parent_rows}
    if not set(AUDITED_ITERATION4_FAILED_HASHES) <= available_hashes:
        raise AssertionError("Embedded iteration-4 failure hashes do not match the parent dataset.")

    promoted_rows = []
    for original in parent_rows:
        row = dict(original)
        row["split"] = "train"
        promoted_rows.append(row)

    strict_variants, parent_by_variant = build_strict_variants(
        builder,
        iteration3_builder,
        parent_rows,
    )
    used_pubids = {
        str(item["source_identifier"])
        for item in parent_manifest["examples"]
        if item["source_dataset"] == builder.PUBMED_REPO
    }
    raw_pubmed_rows, raw_pubmed_manifest = iteration4_builder.build_pubmed_holdouts(
        builder,
        iteration2_builder,
        iteration3_builder,
        used_pubids,
    )
    pubmed_rows, pubmed_manifest = rebuild_holdout_prompts(
        builder,
        iteration3_builder,
        raw_pubmed_rows,
        raw_pubmed_manifest,
    )
    used_protocols = {
        str(item["source_identifier"])
        for item in parent_manifest["examples"]
        if item["source_dataset"] == builder.CADUCEUS_REPO
    }
    protocol_rows, protocol_manifest = build_protocol_holdouts(
        builder,
        iteration2_builder,
        iteration3_builder,
        used_protocols,
    )
    rows = sorted(
        promoted_rows + strict_variants + pubmed_rows + protocol_rows,
        key=lambda row: row["example_hash"],
    )

    iteration4_builder.TOTAL_EXAMPLES = TOTAL_EXAMPLES
    iteration4_builder.EXPECTED_SPLITS = EXPECTED_SPLITS
    summary = iteration4_builder.validate_iteration(rows, builder, iteration3_builder)

    prior_manifest = []
    for original in parent_manifest["examples"]:
        item = dict(original)
        item["split"] = "train"
        prior_manifest.append(item)
    manifest_by_hash = {item["example_hash"]: item for item in parent_manifest["examples"]}
    strict_manifest = []
    for variant in strict_variants:
        parent_hash = parent_by_variant[variant["example_hash"]]
        source_item = manifest_by_hash[parent_hash]
        task = variant["task_type"]
        strict_manifest.append(
            {
                **source_item,
                "example_hash": variant["example_hash"],
                "split": "train",
                "response_contract": (
                    "ExperimentAnalysisSchema"
                    if task == "experiment_analysis"
                    else "StructuredProtocolSchema"
                    if task in builder.PROTOCOL_TASKS
                    else "concise_decision_text"
                ),
                "response_contract_version": "iteration5_exact_measurement_complete_v1",
                "training_role": "iteration5_targeted_contract_replay",
                "parent_example_hash": parent_hash,
            }
        )
    manifest_examples = sorted(
        prior_manifest + strict_manifest + pubmed_manifest + protocol_manifest,
        key=lambda item: item["example_hash"],
    )
    if len(manifest_examples) != len(rows):
        raise AssertionError("Iteration-5 manifest/example count mismatch.")
    return rows, {
        "iteration_schema_version": ITERATION_SCHEMA_VERSION,
        "dataset_schema_version": builder.DATASET_SCHEMA_VERSION,
        "parent_dataset_sha256": EXPECTED_ITERATION4_DATASET_SHA256,
        "parent_review_sha256": EXPECTED_ITERATION4_REVIEW_SHA256,
        "parent_gate_report_sha256": EXPECTED_ITERATION4_GATE_REPORT_SHA256,
        "reason": (
            "Iteration 4 passed structured validity, privacy, and improvement gates but "
            "failed exact measurement fidelity and the 80%-quality gate. Every prior "
            "holdout is training-only; 60 strict source-grounded replays and fresh unseen "
            "holdouts are added."
        ),
        "target_provenance": (
            "No model candidate is a label; targets are expert PubMedQA answers, "
            "deterministic website-schema transformations, or grounded Caduceus excerpts."
        ),
        "failed_adapter_example_hashes": list(AUDITED_ITERATION4_FAILED_HASHES),
        "review_summary": dict(AUDITED_ITERATION4_REVIEW_SUMMARY),
        "summary": summary,
        "sources": parent_manifest["sources"],
        "examples": manifest_examples,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--builder", type=Path, required=True)
    parser.add_argument("--iteration2-builder", type=Path, required=True)
    parser.add_argument("--iteration3-builder", type=Path, required=True)
    parser.add_argument("--iteration4-builder", type=Path, required=True)
    parser.add_argument("--iteration4-jsonl", type=Path, required=True)
    parser.add_argument("--iteration4-manifest", type=Path, required=True)
    parser.add_argument("--iteration4-review", type=Path)
    parser.add_argument("--iteration4-gate-report", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    builder = load_module("biolab_public_builder", args.builder)
    iteration2_builder = load_module("biolab_iteration2_builder", args.iteration2_builder)
    iteration3_builder = load_module("biolab_iteration3_builder", args.iteration3_builder)
    iteration4_builder = load_module("biolab_iteration4_builder", args.iteration4_builder)
    parent_rows, parent_bytes = load_jsonl(args.iteration4_jsonl)
    actual_sha = sha256_bytes(parent_bytes)
    if actual_sha != EXPECTED_ITERATION4_DATASET_SHA256:
        raise AssertionError(
            "Iteration-4 dataset changed: "
            f"expected {EXPECTED_ITERATION4_DATASET_SHA256}, found {actual_sha}."
        )
    parent_manifest = json.loads(args.iteration4_manifest.read_text(encoding="utf-8"))
    if parent_manifest["dataset_sha256"] != actual_sha:
        raise AssertionError("Iteration-4 manifest does not match its JSONL.")
    validate_review_inputs(args.iteration4_review, args.iteration4_gate_report)
    rows, manifest = build_iteration(
        builder,
        iteration2_builder,
        iteration3_builder,
        iteration4_builder,
        parent_rows,
        parent_manifest,
    )
    data = ("\n".join(canonical_json(row) for row in rows) + "\n").encode("utf-8")
    manifest["dataset_sha256"] = sha256_bytes(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(data)
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "dataset_sha256": manifest["dataset_sha256"],
                "failed_adapter_examples": len(AUDITED_ITERATION4_FAILED_HASHES),
                **manifest["summary"],
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
