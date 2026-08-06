#!/usr/bin/env python3
"""Build audited BioLab public-bootstrap iteration 11.

Iteration 11 promotes every iteration-10 holdout to training-only data, adds
source-grounded corrective replays for the blinded decision, scope, schema,
and measurement-fidelity failures, and creates fresh source-group-independent
validation and test splits. Candidate model outputs are never used as labels.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


EXPECTED_ITERATION10_DATASET_SHA256 = (
    "c6ff42f670bba52c14ab1c35da125a8e1c2350b31add0edb3bc16b612a5436bf"
)
EXPECTED_ITERATION10_REVIEW_SHA256 = (
    "90238ab505685e23bcb293b49449ee334710641546709d82147eae8857a59cc3"
)
EXPECTED_ITERATION10_GATE_REPORT_SHA256 = (
    "15c1cd4256bd32625b97134c273b634ae4163004afb106ca317b6ffc7b81b717"
)
FAILED_ITERATION10_EVALUATION_IDS = (
    "eval-0003-2028dcaecca9",
    "eval-0004-26cc63aae255",
    "eval-0005-2949609fbe11",
    "eval-0006-2b27c36a064f",
    "eval-0007-2e3d6350e1ec",
    "eval-0009-75bec9311e30",
    "eval-0010-846b20aba516",
    "eval-0011-87a83030b250",
    "eval-0017-de1f34ba1b43",
    "eval-0018-dfd34518c005",
    "eval-0019-e5b6403a7a2b",
    "eval-0020-ec05d9377443",
)
MEASUREMENT_FAILURE_IDS = (
    "eval-0011-87a83030b250",
    "eval-0017-de1f34ba1b43",
)
AUDITED_ITERATION10_REVIEW_SUMMARY = {
    "review_sha256": EXPECTED_ITERATION10_REVIEW_SHA256,
    "gate_report_sha256": EXPECTED_ITERATION10_GATE_REPORT_SHA256,
    "records": 20,
    "strictly_blind_records": 20,
    "adapter_approval_count": 8,
    "adapter_rating_4_or_5_count": 8,
    "base_approval_count": 3,
    "adapter_measurement_fidelity_count": 18,
    "adapter_privacy_pass_count": 20,
    "adapter_structured_count": 5,
    "adapter_structured_valid_count": 5,
    "passed_gate_count": 3,
    "gate_count": 5,
    "failed_adapter_examples_promoted_for_correction": 12,
    "review_provenance": (
        "AI-assisted scientific review performed by Codex at the BioLab owner's "
        "explicit request; not a human scientist/owner rating."
    ),
}
ITERATION_SCHEMA_VERSION = 10
TOTAL_EXAMPLES = 1520
EXPECTED_SPLITS = Counter({"train": 1480, "validation": 20, "test": 20})
EXPECTED_STRUCTURED_SPLITS = Counter({"train": 410, "validation": 5, "test": 5})
PUBMED_HOLDOUT_DECISIONS = tuple("yes" if index % 2 == 0 else "no" for index in range(18))
PROTOCOL_HOLDOUT_PATHS = {
    "validation": {
        "protocol_generation": "markdown-output/16s-and-gyrb-bacterial-amplification-c6ywzfxe.md",
        "sop_structuring": "markdown-output/cdna-synthesis-using-superscript-iii-first-strand-b64vrgw6.md",
    },
    "test": {
        "protocol_generation": "markdown-output/gibson-assembly-master-mix-assembly-e2611-imsupm.md",
        "sop_structuring": "markdown-output/gibson-assembly-protocol-e5510-imss45.md",
    },
}
EXACTNESS_RULE = (
    "Iteration 11 release rule: Return only the requested format. For decision text, "
    "write exactly Decision: yes., Decision: no., or Decision: maybe. on the first "
    "line, using the source's labeled decision, followed by one complete evidence "
    "paragraph. Preserve negation, scope, and uncertainty; do not turn association "
    "into causation or limited evidence into an absolute claim. Copy source numbers "
    "and units exactly or omit them, and attach each number only to the exact outcome "
    "it modifies in the source. Never invent or derive a measurement, control, "
    "material, procedure, or clinical conclusion."
)
STRUCTURED_RULE = (
    "Iteration 11 JSON rule: Emit one complete JSON object and nothing else. Use every "
    "required key with its exact type and no extra keys. Arrays contain strings except "
    "the three analysis suggestion objects. For protocol tasks, include only explicit "
    "source actions; use Not specified when an operational detail is absent. Before "
    "responding, silently verify JSON syntax, required keys, types, internal "
    "consistency, and source fidelity."
)
FOCUS_RULES = (
    "Lock the first-line decision to the labeled source before writing the explanation.",
    "Use the labeled decision even when the evidence is nuanced; never substitute maybe for a labeled yes or no.",
    "A limited benefit can still have a labeled yes conclusion; preserve both the decision and its limitation.",
    "Preserve every limiting condition and uncertainty qualifier from the source.",
    "Answer the exact question; do not substitute a generic study summary.",
    "Use most, some, may, and association only at the scope supported by the source; avoid unsupported universal claims.",
    "Keep the evidence paragraph concise, complete, and source-bounded.",
    "Do not copy the full source narrative; answer with the decision and one focused evidence paragraph.",
    "Do not add prose before or after a JSON object.",
    "Use exactly the requested JSON keys and value types, and ensure review notes agree with the populated fields.",
    "For structured protocols, use the required schema and only source actions selected by the deterministic target.",
    "For protocols, never infer a step from an abstract, title, or research aim.",
    "Recheck every quoted measurement against the supplied source character-for-character.",
    "Keep every percentage, interval, dose, and count attached to the exact variable or outcome named by the source.",
    "Do not rename a measurement into a different construct; for example, a threshold for a function score is not a percentage of dysfunction.",
    "Do not calculate or report a new percentage unless the supplied source explicitly reports it.",
)


def configure_parent(parent) -> None:
    parent.EXACTNESS_RULE = EXACTNESS_RULE
    parent.STRUCTURED_RULE = STRUCTURED_RULE
    parent.FOCUS_RULES = FOCUS_RULES
    parent.PUBMED_HOLDOUT_DECISIONS = PUBMED_HOLDOUT_DECISIONS
    parent.PROTOCOL_HOLDOUT_PATHS = PROTOCOL_HOLDOUT_PATHS
    if "\n\nIteration 11 release rule:" not in parent.CONTRACT_MARKERS:
        parent.CONTRACT_MARKERS = parent.CONTRACT_MARKERS + ("\n\nIteration 11 release rule:",)
    parent.iteration10_prompt = lambda user, *, focus_index, structured: iteration11_prompt(
        parent, user, focus_index=focus_index, structured=structured
    )


def iteration11_prompt(parent, user: str, *, focus_index: int, structured: bool) -> str:
    parts = [parent.root_prompt(user), EXACTNESS_RULE]
    if structured:
        parts.append(STRUCTURED_RULE)
    parts.append(FOCUS_RULES[focus_index % len(FOCUS_RULES)])
    return "\n\n".join(parts)


def resolve_failed_hashes(parent_rows: list[dict[str, Any]]) -> list[str]:
    test_hashes = [row["example_hash"] for row in parent_rows if row["split"] == "test"]
    failures = []
    for evaluation_id in FAILED_ITERATION10_EVALUATION_IDS:
        prefix = evaluation_id.rsplit("-", 1)[-1]
        matches = [value for value in test_hashes if value.startswith(prefix)]
        if len(matches) != 1:
            raise AssertionError(f"Could not resolve failed evaluation {evaluation_id}.")
        failures.append(matches[0])
    return failures


def build_focused_variants(builder, iteration3_builder, parent, parent_rows, failed_hashes):
    variants: list[dict[str, Any]] = []
    metadata: dict[str, dict[str, str]] = {}
    input_hashes = {row["input_hash"] for row in parent_rows}
    by_hash = {row["example_hash"]: row for row in parent_rows}
    clean = [row for row in parent_rows if not row["messages"][-1]["content"].lstrip().startswith("{")]
    buckets: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in clean:
        if row["task_type"] in builder.PUBMED_TASKS:
            buckets[(row["task_type"], parent.decision_from_target(row["messages"][-1]["content"]))].append(row)
    for bucket in buckets.values():
        bucket.sort(key=lambda row: parent.sha256_text(f"iteration11-focus:{row['example_hash']}"))

    def add(original, focus_index: int, role: str) -> None:
        candidate_index = focus_index
        while True:
            variant = parent.make_variant(
                builder, iteration3_builder, original, focus_index=candidate_index
            )
            if variant["input_hash"] not in input_hashes:
                break
            candidate_index += 1
            if candidate_index - focus_index >= len(FOCUS_RULES):
                raise AssertionError(f"Duplicate iteration-11 focused input for {role}.")
        input_hashes.add(variant["input_hash"])
        variants.append(variant)
        metadata[variant["example_hash"]] = {
            "parent_example_hash": original["example_hash"],
            "training_role": role,
        }

    focus_index = 0
    for task in (task for task in builder.PUBMED_TASKS if task != "experiment_analysis"):
        for decision in ("yes", "no", "maybe"):
            sources = buckets[(task, decision)]
            if len(sources) < 4:
                raise AssertionError(f"Not enough sources for {task}/{decision} replay.")
            for replay_index in range(4):
                add(sources[replay_index], focus_index, "iteration11_balanced_decision_replay")
                focus_index += 1

    for failed_hash in failed_hashes:
        for _ in range(7):
            add(by_hash[failed_hash], focus_index, "iteration11_failed_case_replay")
            focus_index += 1

    for decision in ("yes", "no", "maybe"):
        sources = buckets[("experiment_analysis", decision)]
        eligible = []
        for source in sources:
            try:
                parent.make_variant(builder, iteration3_builder, source, focus_index=0)
            except AssertionError as error:
                if "unsupported numbers" in str(error):
                    continue
                raise
            eligible.append(source)
        if len(eligible) < 6:
            raise AssertionError(f"Not enough structured sources for {decision} replay.")
        for replay_index in range(6):
            add(eligible[replay_index], focus_index, "iteration11_structured_analysis_replay")
            focus_index += 1

    for task in builder.PROTOCOL_TASKS:
        sources = sorted(
            (row for row in parent_rows if row["task_type"] == task),
            key=lambda row: parent.sha256_text(f"iteration11-protocol:{row['example_hash']}"),
        )
        for replay_index in range(13):
            add(sources[replay_index], focus_index, "iteration11_protocol_schema_replay")
            focus_index += 1

    expected = Counter({
        "iteration11_balanced_decision_replay": 72,
        "iteration11_failed_case_replay": 84,
        "iteration11_structured_analysis_replay": 18,
        "iteration11_protocol_schema_replay": 26,
    })
    if len(variants) != 200 or Counter(item["training_role"] for item in metadata.values()) != expected:
        raise AssertionError("Iteration-11 focused replay plan is incomplete.")
    return variants, metadata


def validate_review_inputs(parent, review_path: Path | None, gate_report_path: Path | None) -> None:
    if review_path is not None:
        actual = parent.sha256_bytes(review_path.read_bytes())
        if actual != EXPECTED_ITERATION10_REVIEW_SHA256:
            raise AssertionError(f"Iteration-10 review changed: expected {EXPECTED_ITERATION10_REVIEW_SHA256}, found {actual}.")
        review = json.loads(review_path.read_text(encoding="utf-8"))
        if not isinstance(review, list) or len(review) != 20:
            raise AssertionError("Iteration-10 review must contain exactly 20 ratings.")
    if gate_report_path is not None:
        actual = parent.sha256_bytes(gate_report_path.read_bytes())
        if actual != EXPECTED_ITERATION10_GATE_REPORT_SHA256:
            raise AssertionError(f"Iteration-10 gate report changed: expected {EXPECTED_ITERATION10_GATE_REPORT_SHA256}, found {actual}.")
        report = json.loads(gate_report_path.read_text(encoding="utf-8"))
        if report.get("release_gates_passed") is not False or report.get("disposition") != "quarantined":
            raise AssertionError("Iteration-10 gate report is not the quarantined result.")
        gates = report.get("gates", {})
        if len(gates) != 5 or sum(bool(value) for value in gates.values()) != 3:
            raise AssertionError("Iteration-10 gate totals do not match the audited result.")


def build_iteration(builder, iteration2_builder, iteration3_builder, iteration4_builder, parent, parent_rows, parent_manifest):
    failed_hashes = resolve_failed_hashes(parent_rows)
    promoted_rows = [{**row, "split": "train"} for row in parent_rows]
    variants, variant_metadata = build_focused_variants(
        builder, iteration3_builder, parent, parent_rows, failed_hashes
    )
    used_pubids = {
        str(item["source_identifier"])
        for item in parent_manifest["examples"]
        if item["source_dataset"] == builder.PUBMED_REPO
    }
    pubmed_rows, pubmed_manifest = parent.build_pubmed_holdouts(
        builder, iteration2_builder, iteration3_builder, used_pubids
    )
    used_protocols = {
        str(item["source_identifier"])
        for item in parent_manifest["examples"]
        if item["source_dataset"] == builder.CADUCEUS_REPO
    }
    protocol_rows, protocol_manifest = parent.build_protocol_holdouts(
        builder, iteration2_builder, iteration3_builder, used_protocols
    )
    for item in pubmed_manifest + protocol_manifest:
        item["response_contract_version"] = "iteration11_decision_measurement_fidelity_v1"
    rows = sorted(promoted_rows + variants + pubmed_rows + protocol_rows, key=lambda row: row["example_hash"])

    iteration4_builder.TOTAL_EXAMPLES = TOTAL_EXAMPLES
    iteration4_builder.EXPECTED_SPLITS = EXPECTED_SPLITS
    summary = iteration4_builder.validate_iteration(rows, builder, iteration3_builder)
    if Counter(summary["structured_counts"]) != EXPECTED_STRUCTURED_SPLITS:
        raise AssertionError(f"Unexpected structured split counts: {summary['structured_counts']}")

    prior_manifest = [{**item, "split": "train"} for item in parent_manifest["examples"]]
    manifest_by_hash = {item["example_hash"]: item for item in parent_manifest["examples"]}
    variant_manifest = []
    for variant in variants:
        details = variant_metadata[variant["example_hash"]]
        source_item = manifest_by_hash[details["parent_example_hash"]]
        variant_manifest.append({
            **source_item,
            "example_hash": variant["example_hash"],
            "split": "train",
            "response_contract": parent.task_contract(builder, variant["task_type"]),
            "response_contract_version": "iteration11_decision_measurement_fidelity_v1",
            **details,
        })
    manifest_examples = sorted(
        prior_manifest + variant_manifest + pubmed_manifest + protocol_manifest,
        key=lambda item: item["example_hash"],
    )
    if len(manifest_examples) != len(rows):
        raise AssertionError("Iteration-11 manifest/example count mismatch.")
    return rows, {
        "iteration_schema_version": ITERATION_SCHEMA_VERSION,
        "dataset_schema_version": builder.DATASET_SCHEMA_VERSION,
        "parent_dataset_sha256": EXPECTED_ITERATION10_DATASET_SHA256,
        "parent_review_sha256": EXPECTED_ITERATION10_REVIEW_SHA256,
        "parent_gate_report_sha256": EXPECTED_ITERATION10_GATE_REPORT_SHA256,
        "reason": (
            "Iteration 10 passed structured validity, privacy, and improvement gates but "
            "failed measurement fidelity and the 80% held-out quality gate. Every prior "
            "holdout is now training-only; 200 source-grounded corrective replays and "
            "fresh unseen holdouts target exact decisions, measurement ownership, scope, "
            "internal consistency, and concise source-bounded conclusions."
        ),
        "holdout_note": (
            "Unused PubMedQA maybe groups remain exhausted, so fresh iteration-11 PubMedQA "
            "holdouts are balanced yes/no while training retains yes/no/maybe coverage."
        ),
        "target_provenance": (
            "No model candidate is a label; targets are expert PubMedQA answers, deterministic "
            "website-schema transformations, or grounded Caduceus excerpts."
        ),
        "failed_adapter_example_hashes": sorted(failed_hashes),
        "failed_adapter_evaluation_ids": list(FAILED_ITERATION10_EVALUATION_IDS),
        "measurement_failure_evaluation_ids": list(MEASUREMENT_FAILURE_IDS),
        "review_summary": dict(AUDITED_ITERATION10_REVIEW_SUMMARY),
        "replay_counts": dict(sorted(Counter(item["training_role"] for item in variant_metadata.values()).items())),
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
    parser.add_argument("--iteration10-builder", type=Path, required=True)
    parser.add_argument("--iteration10-jsonl", type=Path, required=True)
    parser.add_argument("--iteration10-manifest", type=Path, required=True)
    parser.add_argument("--iteration10-review", type=Path)
    parser.add_argument("--iteration10-gate-report", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    loader = __import__("importlib.util", fromlist=["util"])
    def load(name: str, path: Path):
        spec = loader.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Could not import {name} from {path}.")
        module = loader.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    builder = load("biolab_public_builder", args.builder)
    iteration2_builder = load("biolab_iteration2_builder", args.iteration2_builder)
    iteration3_builder = load("biolab_iteration3_builder", args.iteration3_builder)
    iteration4_builder = load("biolab_iteration4_builder", args.iteration4_builder)
    parent = load("biolab_iteration10_builder", args.iteration10_builder)
    configure_parent(parent)
    parent_rows, parent_bytes = parent.load_jsonl(args.iteration10_jsonl)
    actual_sha = parent.sha256_bytes(parent_bytes)
    if actual_sha != EXPECTED_ITERATION10_DATASET_SHA256:
        raise AssertionError(f"Iteration-10 dataset changed: expected {EXPECTED_ITERATION10_DATASET_SHA256}, found {actual_sha}.")
    parent_manifest = json.loads(args.iteration10_manifest.read_text(encoding="utf-8"))
    if parent_manifest["dataset_sha256"] != actual_sha:
        raise AssertionError("Iteration-10 manifest does not match its JSONL.")
    validate_review_inputs(parent, args.iteration10_review, args.iteration10_gate_report)
    rows, manifest = build_iteration(
        builder, iteration2_builder, iteration3_builder, iteration4_builder,
        parent, parent_rows, parent_manifest
    )
    data = ("\n".join(parent.canonical_json(row) for row in rows) + "\n").encode("utf-8")
    manifest["dataset_sha256"] = parent.sha256_bytes(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(data)
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "dataset_sha256": manifest["dataset_sha256"],
        "failed_adapter_examples": len(manifest["failed_adapter_example_hashes"]),
        "replay_counts": manifest["replay_counts"],
        **manifest["summary"],
    }, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
