#!/usr/bin/env python3
"""Build the fourth audited Bio-Lab public-bootstrap iteration.

Iteration 4 quarantines the third adapter, promotes every iteration-3 holdout to
training-only data, adds new strict response-contract replays, and creates fresh
validation/test groups. Targets remain deterministic transformations of pinned
MIT/CC-BY sources; no model answer is ever used as a label.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


EXPECTED_ITERATION3_DATASET_SHA256 = (
    "b26b7554472ca42c200465dda24efffc57145d0014a251c86c32119a26786165"
)
EXPECTED_ITERATION3_REVIEW_SHA256 = (
    "dc564290f6e902ff53f01e98c87455d3bfd18898a7e259eec86420a50b2b2810"
)
AUDITED_ITERATION3_FAILED_HASHES = (
    "127b129afa779d0513a1642abfc98febdcc83bf81a98b5a0e0fe27cd345bace9",
    "2f5d9e66fc9a4ea8d2192317a31c02d59322d2f0fc354173977141a696c384bb",
    "415ed1c54cecaca0fa36c5763f9a891bf4fcdbac6b8ebd91d70484e92596b452",
    "5a802147b06cd69d3bbafa3268ed74a7d98821fba8c26a710c878e434874deef",
    "6b46010c0f2ff27cd20959e94dbfce8a5f3151a68fefe15d887a91bc92a89100",
    "975e5342dffc71ff08b9beb2ea8c9f9a491ce7d6950678fce7c8c010205a0028",
    "9ac51218894cdc3e42f853e5bf8604debd0897c92aac58f4aea4519bddb7c845",
    "a1e89b155656148e5fe5b6d0d5b046dcf4be878e9878b3157058dd479334508d",
    "d900ce3363c98f2afb68d0cc73acd035070469378e10f59afb2a8e9faa5153e4",
    "dcfb10ce4be4d5e8e91811c95aeba0d40523f2ce876875379c52ecdf7035c8f3",
    "e3a00ff86914badcda3a26fa43141987b0033f511dc4b1a68fb12e9dd1c36661",
    "e7289ff056b8a733c518acb07ea272e6b45a6ac9b24812f90280eb2f9e244090",
)
AUDITED_ITERATION3_REVIEW_SUMMARY = {
    "review_sha256": EXPECTED_ITERATION3_REVIEW_SHA256,
    "records": 20,
    "adapter_approval_count": 8,
    "adapter_rating_4_or_5_count": 8,
    "adapter_measurement_fidelity_count": 17,
    "adapter_privacy_pass_count": 20,
    "adapter_structured_count": 5,
    "adapter_structured_valid_count": 2,
    "failed_adapter_examples_promoted_for_correction": 12,
}
ITERATION_SCHEMA_VERSION = 3
TOTAL_EXAMPLES = 380
EXPECTED_SPLITS = Counter({"train": 340, "validation": 20, "test": 20})
STRICT_VARIANT_COUNTS = {
    "experiment_analysis": 10,
    "data_analysis": 5,
    "experiment_chat": 4,
    "experiment_comparison": 4,
    "project_chat": 3,
    "project_synthesis": 2,
    "general_chat": 2,
    "protocol_generation": 5,
    "sop_structuring": 5,
}
PUBMED_HOLDOUT_COUNTS = {
    "experiment_analysis": 3,
    "data_analysis": 3,
    "experiment_chat": 3,
    "experiment_comparison": 3,
    "project_chat": 2,
    "project_synthesis": 2,
    "general_chat": 2,
}
PUBMED_PER_HOLDOUT = sum(PUBMED_HOLDOUT_COUNTS.values())
PROTOCOL_HOLDOUT_PATHS = {
    "validation": {
        "protocol_generation": (
            "markdown-output/estimating-microbial-population-data-from-optical-cgumtwu6.md"
        ),
        "sop_structuring": "markdown-output/gradient-pcr-with-dmso-by6kpzcw.md",
    },
    "test": {
        "protocol_generation": (
            "markdown-output/using-tracefinder-and-excel-software-to-evaluate-a-czajx2cn.md"
        ),
        "sop_structuring": (
            "markdown-output/multisite-gateway-calculations-excel-spreadsheet-b4xdqxi6.md"
        ),
    },
}

PRIVACY_PATTERNS = {
    "email": re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
    "clerk_user_id": re.compile(r"\buser_[A-Za-z0-9]{6,}\b"),
    "absolute_path": re.compile(
        r"(?i)(?:/(?:Users|home|var|tmp)/[^\s]+|[A-Z]:\\[^\s]+)"
    ),
    "credential": re.compile(
        r"(?i)\b(?:bearer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9_-]{8,}|"
        r"api[_-]?(?:key|token)\s*[:=]\s*[^\s]+)"
    ),
    "filename": re.compile(
        r"(?i)\b[^\s/\\]+\.(?:csv|tsv|xls|xlsx|doc|docx|pdf|json|zip)\b"
    ),
}


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


def parsed_bool(value: Any, *, field: str, evaluation_id: str) -> bool:
    normalized = str(value).strip().lower()
    if normalized not in {"true", "false"}:
        raise AssertionError(f"{evaluation_id}: {field} must be true or false.")
    return normalized == "true"


def parse_iteration3_failures(
    review_path: Path | None,
    iteration3_rows: list[dict[str, Any]],
) -> tuple[list[str], dict[str, Any]]:
    available_hashes = {row["example_hash"] for row in iteration3_rows}
    if review_path is None:
        failures = sorted(AUDITED_ITERATION3_FAILED_HASHES)
        if not set(failures) <= available_hashes:
            raise AssertionError("Embedded iteration-3 failure hashes do not match the dataset.")
        return failures, dict(AUDITED_ITERATION3_REVIEW_SUMMARY)

    review_bytes = review_path.read_bytes()
    review_sha = sha256_bytes(review_bytes)
    if review_sha != EXPECTED_ITERATION3_REVIEW_SHA256:
        raise AssertionError(
            "Iteration-3 blind review changed: "
            f"expected {EXPECTED_ITERATION3_REVIEW_SHA256}, found {review_sha}."
        )
    test_by_prefix = {
        row["example_hash"][:12]: row
        for row in iteration3_rows
        if row["split"] == "test"
    }
    records = list(csv.DictReader(review_path.open(encoding="utf-8", newline="")))
    if len(records) != 20:
        raise AssertionError(f"Expected 20 reviewed examples, found {len(records)}.")

    failures: list[str] = []
    metrics = Counter()
    for record in records:
        evaluation_id = record["evaluation_id"]
        prefix = evaluation_id.rsplit("-", 1)[-1]
        if prefix not in test_by_prefix:
            raise AssertionError(f"Unknown review example prefix {prefix}.")
        candidate = "a" if int(prefix[:8], 16) % 2 == 1 else "b"
        rating = int(record[f"candidate_{candidate}_rating"])
        if rating < 1 or rating > 5:
            raise AssertionError(f"{evaluation_id}: adapter rating must be 1..5.")
        approved = parsed_bool(
            record[f"candidate_{candidate}_approved"],
            field="approved",
            evaluation_id=evaluation_id,
        )
        fidelity = parsed_bool(
            record[f"candidate_{candidate}_measurement_fidelity"],
            field="measurement_fidelity",
            evaluation_id=evaluation_id,
        )
        privacy = parsed_bool(
            record[f"candidate_{candidate}_privacy_pass"],
            field="privacy_pass",
            evaluation_id=evaluation_id,
        )
        structured = parsed_bool(
            record["reference_is_structured"],
            field="reference_is_structured",
            evaluation_id=evaluation_id,
        )
        json_valid = parsed_bool(
            record[f"candidate_{candidate}_json_valid"],
            field="json_valid",
            evaluation_id=evaluation_id,
        )
        schema_valid = parsed_bool(
            record[f"candidate_{candidate}_schema_valid"],
            field="schema_valid",
            evaluation_id=evaluation_id,
        )
        structured_valid = (not structured) or (json_valid and schema_valid)
        metrics["adapter_approval_count"] += int(approved)
        metrics["adapter_rating_4_or_5_count"] += int(rating >= 4)
        metrics["adapter_measurement_fidelity_count"] += int(fidelity)
        metrics["adapter_privacy_pass_count"] += int(privacy)
        metrics["adapter_structured_count"] += int(structured)
        metrics["adapter_structured_valid_count"] += int(structured and structured_valid)
        if not (approved and rating >= 4 and fidelity and privacy and structured_valid):
            failures.append(test_by_prefix[prefix]["example_hash"])

    expected_metrics = {
        key: value
        for key, value in AUDITED_ITERATION3_REVIEW_SUMMARY.items()
        if key.startswith("adapter_") and key != "adapter_structured_count"
    }
    actual_metrics = {key: metrics[key] for key in expected_metrics}
    if actual_metrics != expected_metrics:
        raise AssertionError(
            "Blind review does not reproduce verified iteration-3 adapter metrics: "
            f"{actual_metrics}."
        )
    if metrics["adapter_structured_count"] != 5 or len(failures) != 12:
        raise AssertionError("Iteration-3 structured/failure counts changed.")
    return sorted(failures), {
        "review_sha256": review_sha,
        "records": len(records),
        **dict(metrics),
        "failed_adapter_examples_promoted_for_correction": len(failures),
    }


def build_strict_train_variants(
    builder,
    iteration3_builder,
    iteration3_rows: list[dict[str, Any]],
    iteration3_manifest: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    strict_hashes = {
        item["example_hash"]
        for item in iteration3_manifest["examples"]
        if item.get("training_role") == "strict_contract_replay"
    }
    variants: list[dict[str, Any]] = []
    source_by_variant: dict[str, str] = {}
    existing_input_hashes = {row["input_hash"] for row in iteration3_rows}
    original_train = [
        row
        for row in iteration3_rows
        if row["split"] == "train"
        and row["example_hash"] not in strict_hashes
        and "Response contract:" not in row["messages"][-2]["content"]
        and "Return valid JSON only" not in row["messages"][-2]["content"]
    ]
    for task, count in STRICT_VARIANT_COUNTS.items():
        candidates = sorted(
            (row for row in original_train if row["task_type"] == task),
            key=lambda row: sha256_text(
                f"biolab-iteration4-strict-variant-v1:{row['example_hash']}"
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
                    f"iteration4-{original['example_hash']}",
                )
            else:
                user = iteration3_builder.strict_pubmed_prompt(old_user, structured=False)
                target = old_target
            if target.lstrip().startswith("{"):
                prompt = "\n".join(
                    [original["messages"][0]["content"], user]
                )
                if iteration3_builder.unsupported_numbers(target, prompt):
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
            raise AssertionError(f"Not enough clean train rows for strict task {task}.")
        for original, variant in eligible[:count]:
            variants.append(variant)
            source_by_variant[variant["example_hash"]] = original["example_hash"]
    if len(variants) != 40:
        raise AssertionError(f"Expected 40 iteration-4 strict variants, found {len(variants)}.")
    return variants, source_by_variant


def build_pubmed_holdouts(
    builder,
    iteration2_builder,
    iteration3_builder,
    used_pubids: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, str]]] = defaultdict(list)
    for raw in builder.fetch_pubmed_rows():
        normalized = iteration2_builder.normalize_pubmed_row(builder, raw)
        if normalized is None or normalized["pubid"] in used_pubids:
            continue
        buckets[normalized["decision"]].append(normalized)

    selected: list[dict[str, str]] = []
    per_decision = (PUBMED_PER_HOLDOUT * 2) // 3
    for decision in ("yes", "no", "maybe"):
        candidates = sorted(
            buckets[decision],
            key=lambda row: sha256_text(
                f"biolab-pubmed-iteration4-selection-v1:{row['pubid']}"
            ),
        )
        if len(candidates) < per_decision:
            raise AssertionError(f"Not enough unused PubMedQA rows for {decision}.")
        selected.extend(candidates[:per_decision])
    selected.sort(
        key=lambda row: sha256_text(
            f"biolab-pubmed-iteration4-order-v1:{row['pubid']}"
        )
    )

    rows: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    cursor = 0
    for split in ("validation", "test"):
        for task in builder.PUBMED_TASKS:
            count = PUBMED_HOLDOUT_COUNTS[task]
            for source in selected[cursor : cursor + count]:
                base_user = builder.pubmed_prompt(task, source["question"], source["evidence"])
                base_target = f"Decision: {source['decision']}.\n\n{source['answer']}"
                structured = task == "experiment_analysis"
                user = iteration3_builder.strict_pubmed_prompt(base_user, structured=structured)
                target = (
                    iteration3_builder.analysis_json_target(base_target)
                    if structured
                    else base_target
                )
                row = iteration3_builder.make_row(
                    builder,
                    task=task,
                    split=split,
                    source_group=f"{builder.PUBMED_REPO}:{source['pubid']}",
                    user_content=user,
                    assistant_content=target,
                )
                rows.append(row)
                manifest.append(
                    {
                        "example_hash": row["example_hash"],
                        "task_type": task,
                        "split": split,
                        "source_dataset": builder.PUBMED_REPO,
                        "source_revision": builder.PUBMED_REVISION,
                        "source_identifier": source["pubid"],
                        "source_url": f"https://pubmed.ncbi.nlm.nih.gov/{source['pubid']}/",
                        "source_license": builder.PUBMED_LICENSE,
                        "source_attribution": "PubMedQA authors and labeled-dataset annotators",
                        "response_contract": (
                            "ExperimentAnalysisSchema" if structured else "concise_decision_text"
                        ),
                    }
                )
            cursor += count
    if cursor != len(selected) or len(rows) != 36:
        raise AssertionError("Iteration-4 PubMedQA holdout allocation failed.")
    return rows, manifest


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
                raise AssertionError(f"Protocol holdout was already used: {path}")
            markdown_row, item = iteration2_builder.protocol_validation_row(builder, task, path)
            user = iteration3_builder.strict_protocol_prompt(
                markdown_row["messages"][-2]["content"]
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
                }
            )
            rows.append(row)
            manifest.append(updated)
    if len(rows) != 4:
        raise AssertionError("Iteration-4 protocol holdout count failed.")
    return rows, manifest


def validate_iteration(rows: list[dict[str, Any]], builder, iteration3_builder) -> dict[str, Any]:
    if len(rows) != TOTAL_EXAMPLES:
        raise AssertionError(f"Expected {TOTAL_EXAMPLES} examples, found {len(rows)}.")
    split_counts = Counter(row["split"] for row in rows)
    if split_counts != EXPECTED_SPLITS:
        raise AssertionError(f"Unexpected iteration-4 splits: {dict(split_counts)}")
    expected_keys = {
        "dataset_schema_version",
        "source_schema_version",
        "task_type",
        "split",
        "provenance",
        "group_hash",
        "input_hash",
        "example_hash",
        "messages",
    }
    input_hashes: set[str] = set()
    example_hashes: set[str] = set()
    group_splits: dict[str, set[str]] = defaultdict(set)
    split_tasks: dict[str, set[str]] = defaultdict(set)
    task_counts = Counter()
    structured_counts = Counter()
    for index, row in enumerate(rows, start=1):
        if set(row) != expected_keys:
            raise AssertionError(f"Row {index} has unexpected keys.")
        if row["dataset_schema_version"] != builder.DATASET_SCHEMA_VERSION:
            raise AssertionError(f"Row {index} has an invalid dataset schema.")
        if row["source_schema_version"] < 1 or row["provenance"] != "public_licensed":
            raise AssertionError(f"Row {index} has invalid provenance/schema.")
        if row["task_type"] not in builder.ALL_TASKS or row["split"] not in builder.SPLITS:
            raise AssertionError(f"Row {index} has invalid task/split.")
        if row["input_hash"] in input_hashes or row["example_hash"] in example_hashes:
            raise AssertionError(f"Duplicate input/example at row {index}.")
        input_hashes.add(row["input_hash"])
        example_hashes.add(row["example_hash"])
        group_splits[row["group_hash"]].add(row["split"])
        split_tasks[row["split"]].add(row["task_type"])
        task_counts[row["task_type"]] += 1
        if [message.get("role") for message in row["messages"]] != [
            "system",
            "user",
            "assistant",
        ]:
            raise AssertionError(f"Row {index} has invalid message roles.")
        joined = "\n".join(message["content"] for message in row["messages"])
        privacy_findings = [
            finding
            for finding, pattern in PRIVACY_PATTERNS.items()
            if pattern.search(joined)
        ]
        if privacy_findings:
            raise AssertionError(
                f"Row {index} failed the privacy scan: {privacy_findings}."
            )
        target = row["messages"][-1]["content"]
        if target.lstrip().startswith("{"):
            iteration3_builder.validate_structured_target(row["task_type"], target)
            structured_counts[row["split"]] += 1
            prompt = "\n".join(message["content"] for message in row["messages"][:-1])
            unsupported = iteration3_builder.unsupported_numbers(target, prompt)
            if unsupported:
                raise AssertionError(
                    f"Structured row {index} has unsupported numbers: {unsupported}"
                )
    if any(len(splits) != 1 for splits in group_splits.values()):
        raise AssertionError("A public source group leaked across splits.")
    required_tasks = set(builder.ALL_TASKS)
    for split in ("validation", "test"):
        if split_tasks[split] != required_tasks:
            raise AssertionError(
                f"{split} lacks task coverage: {sorted(required_tasks - split_tasks[split])}"
            )
        if structured_counts[split] != 5:
            raise AssertionError(
                f"{split} needs five structured examples, found {structured_counts[split]}."
            )
    return {
        "examples": len(rows),
        "split_counts": dict(sorted(split_counts.items())),
        "task_counts": dict(sorted(task_counts.items())),
        "structured_counts": dict(sorted(structured_counts.items())),
        "holdout_task_coverage": {
            split: sorted(split_tasks[split]) for split in ("validation", "test")
        },
        "privacy_findings": 0,
        "provenance": "public_licensed",
    }


def build_iteration(
    builder,
    iteration2_builder,
    iteration3_builder,
    iteration3_rows: list[dict[str, Any]],
    iteration3_manifest: dict[str, Any],
    failed_hashes: list[str],
    review_summary: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    promoted_rows = []
    for original in iteration3_rows:
        row = dict(original)
        row["split"] = "train"
        promoted_rows.append(row)

    strict_variants, source_by_variant = build_strict_train_variants(
        builder,
        iteration3_builder,
        iteration3_rows,
        iteration3_manifest,
    )
    used_pubids = {
        str(item["source_identifier"])
        for item in iteration3_manifest["examples"]
        if item["source_dataset"] == builder.PUBMED_REPO
    }
    used_protocols = {
        str(item["source_identifier"])
        for item in iteration3_manifest["examples"]
        if item["source_dataset"] == builder.CADUCEUS_REPO
    }
    pubmed_holdouts, pubmed_manifest = build_pubmed_holdouts(
        builder,
        iteration2_builder,
        iteration3_builder,
        used_pubids,
    )
    protocol_holdouts, protocol_manifest = build_protocol_holdouts(
        builder,
        iteration2_builder,
        iteration3_builder,
        used_protocols,
    )
    rows = sorted(
        promoted_rows + strict_variants + pubmed_holdouts + protocol_holdouts,
        key=lambda row: row["example_hash"],
    )
    summary = validate_iteration(rows, builder, iteration3_builder)

    prior_manifest = []
    for original in iteration3_manifest["examples"]:
        item = dict(original)
        item["split"] = "train"
        prior_manifest.append(item)
    manifest_by_hash = {
        item["example_hash"]: item for item in iteration3_manifest["examples"]
    }
    strict_manifest = []
    for variant in strict_variants:
        parent_hash = source_by_variant[variant["example_hash"]]
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
                "training_role": "iteration4_targeted_contract_replay",
                "parent_example_hash": parent_hash,
            }
        )
    manifest_examples = sorted(
        prior_manifest + strict_manifest + pubmed_manifest + protocol_manifest,
        key=lambda item: item["example_hash"],
    )
    if len(manifest_examples) != len(rows):
        raise AssertionError("Iteration-4 manifest/example count mismatch.")
    return rows, {
        "iteration_schema_version": ITERATION_SCHEMA_VERSION,
        "dataset_schema_version": builder.DATASET_SCHEMA_VERSION,
        "parent_dataset_sha256": EXPECTED_ITERATION3_DATASET_SHA256,
        "parent_review_sha256": EXPECTED_ITERATION3_REVIEW_SHA256,
        "reason": (
            "Iteration 3 improved approval over the base model but failed structured-output, "
            "measurement-fidelity, and 80%-quality gates. Every prior holdout is now "
            "training-only; strict contract replays and fresh independent holdouts are added."
        ),
        "target_provenance": (
            "No model output is a label; targets are expert PubMedQA answers, deterministic "
            "website-schema transformations, or grounded Caduceus protocol excerpts."
        ),
        "failed_adapter_example_hashes": failed_hashes,
        "review_summary": review_summary,
        "summary": summary,
        "sources": iteration3_manifest["sources"],
        "examples": manifest_examples,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--builder", type=Path, required=True)
    parser.add_argument("--iteration2-builder", type=Path, required=True)
    parser.add_argument("--iteration3-builder", type=Path, required=True)
    parser.add_argument("--iteration3-jsonl", type=Path, required=True)
    parser.add_argument("--iteration3-manifest", type=Path, required=True)
    parser.add_argument("--iteration3-review", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    builder = load_module("biolab_public_builder", args.builder)
    iteration2_builder = load_module("biolab_iteration2_builder", args.iteration2_builder)
    iteration3_builder = load_module("biolab_iteration3_builder", args.iteration3_builder)
    iteration3_rows, iteration3_bytes = load_jsonl(args.iteration3_jsonl)
    actual_sha = sha256_bytes(iteration3_bytes)
    if actual_sha != EXPECTED_ITERATION3_DATASET_SHA256:
        raise AssertionError(
            "Iteration-3 dataset changed: "
            f"expected {EXPECTED_ITERATION3_DATASET_SHA256}, found {actual_sha}."
        )
    iteration3_manifest = json.loads(args.iteration3_manifest.read_text(encoding="utf-8"))
    if iteration3_manifest["dataset_sha256"] != actual_sha:
        raise AssertionError("Iteration-3 manifest does not match its JSONL.")
    failed_hashes, review_summary = parse_iteration3_failures(
        args.iteration3_review,
        iteration3_rows,
    )
    rows, manifest = build_iteration(
        builder,
        iteration2_builder,
        iteration3_builder,
        iteration3_rows,
        iteration3_manifest,
        failed_hashes,
        review_summary,
    )
    data = ("\n".join(canonical_json(row) for row in rows) + "\n").encode("utf-8")
    manifest["dataset_sha256"] = sha256_bytes(data)
    args.output.write_bytes(data)
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "dataset_sha256": manifest["dataset_sha256"],
                "failed_adapter_examples": len(failed_hashes),
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
