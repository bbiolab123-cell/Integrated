#!/usr/bin/env python3
"""Build audited BioLab public-bootstrap iteration 10.

Iteration 10 promotes every iteration-9 holdout to training-only data, adds
source-grounded corrective replays for each failed adapter case, and creates
fresh source-group-independent validation and test splits. Candidate model
outputs are never used as labels.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


EXPECTED_ITERATION9_DATASET_SHA256 = (
    "1944dae6e4581232091805493062364efb5fa5dd182f6e55b57e61028b923dbd"
)
EXPECTED_ITERATION9_REVIEW_SHA256 = (
    "84aa9248348899c9690d8d12cf3c987d090f1e676b04e886eb6cbfd8d494cec1"
)
EXPECTED_ITERATION9_GATE_REPORT_SHA256 = (
    "5db3d76a5429cc4df1a860085aa5758c2e680b3fe63d6f2b5fb2606b588e70c5"
)
FAILED_ITERATION9_EVALUATION_IDS = (
    "eval-0001-076f2f07f7a7",
    "eval-0002-104ab16cfc75",
    "eval-0004-23ea59e3d319",
    "eval-0005-27cf3f824f5a",
    "eval-0006-3100ec641725",
    "eval-0010-5936c4909a8c",
    "eval-0012-7c9f99dab8e3",
    "eval-0013-93633bbf27ce",
    "eval-0014-9814b5e1685a",
    "eval-0015-99940709b19c",
    "eval-0017-9e81f23cfa48",
    "eval-0018-a7557fcc274e",
    "eval-0019-d073713e8cf9",
)
AUDITED_ITERATION9_REVIEW_SUMMARY = {
    "review_sha256": EXPECTED_ITERATION9_REVIEW_SHA256,
    "gate_report_sha256": EXPECTED_ITERATION9_GATE_REPORT_SHA256,
    "records": 20,
    "strictly_blind_records": 20,
    "adapter_approval_count": 7,
    "adapter_rating_4_or_5_count": 7,
    "base_approval_count": 3,
    "adapter_measurement_fidelity_count": 19,
    "adapter_privacy_pass_count": 20,
    "adapter_structured_count": 5,
    "adapter_structured_valid_count": 4,
    "passed_gate_count": 2,
    "gate_count": 5,
    "failed_adapter_examples_promoted_for_correction": 13,
    "review_provenance": (
        "AI-assisted scientific review performed by Codex at the BioLab owner's "
        "explicit request; not a human scientist/owner rating."
    ),
}
ITERATION_SCHEMA_VERSION = 9
TOTAL_EXAMPLES = 1280
EXPECTED_SPLITS = Counter({"train": 1240, "validation": 20, "test": 20})
EXPECTED_STRUCTURED_SPLITS = Counter({"train": 335, "validation": 5, "test": 5})
PUBMED_HOLDOUT_DECISIONS = tuple("yes" if index % 2 == 0 else "no" for index in range(18))
PROTOCOL_HOLDOUT_PATHS = {
    "validation": {
        "protocol_generation": (
            "markdown-output/edna-fish-metabarcoding-pcr-12s-cytb-fckbiuw.md"
        ),
        "sop_structuring": (
            "markdown-output/agarose-gel-electrophoresis-1-2-with-ethidum-bromi-ds76hm.md"
        ),
    },
    "test": {
        "protocol_generation": (
            "markdown-output/around-the-horn-pcr-and-cloning-rf2d3qe.md"
        ),
        "sop_structuring": (
            "markdown-output/pcr-cleanup-bpvqmn5w.md"
        ),
    },
}
EXACTNESS_RULE = (
    "Iteration 10 release rule: Return only the requested format. For decision text, "
    "write exactly Decision: yes., Decision: no., or Decision: maybe. on the first "
    "line, using the source's labeled decision, followed by one complete evidence "
    "paragraph. Preserve negation, scope, and uncertainty; do not turn association "
    "into causation. Copy source numbers and units exactly or omit them. Never invent "
    "a measurement, control, material, procedure, or clinical conclusion."
)
STRUCTURED_RULE = (
    "Iteration 10 JSON rule: Emit one complete JSON object and nothing else. Use every "
    "required key with its exact type and no extra keys. Arrays contain strings except "
    "the three analysis suggestion objects. For protocol tasks, include only explicit "
    "source actions; use Not specified when an operational detail is absent. Before "
    "responding, silently verify JSON syntax, required keys, types, and source fidelity."
)
FOCUS_RULES = (
    "Lock the first-line decision to the labeled source before writing the explanation.",
    "Use the labeled decision even when the evidence is nuanced; never substitute maybe for a labeled yes or no.",
    "Preserve every limiting condition and uncertainty qualifier from the source.",
    "Answer the exact question; do not substitute a generic study summary.",
    "Keep the evidence paragraph concise, complete, and source-bounded.",
    "Do not copy the full source narrative; answer with the decision and one focused evidence paragraph.",
    "Do not add prose before or after a JSON object.",
    "Use exactly the requested JSON keys and value types.",
    "For structured protocols, use the required schema and only source actions selected by the deterministic target.",
    "For protocols, never infer a step from an abstract, title, or research aim.",
    "Recheck every quoted measurement against the supplied source character-for-character.",
    "Do not calculate or report a new percentage unless the supplied source explicitly reports it.",
)
CONTRACT_MARKERS = (
    "\n\nResponse contract:",
    "\n\nReturn valid JSON only",
    "\n\nIteration 4 exactness rule:",
    "\n\nIteration 5 exactness rule:",
    "\n\nIteration 6 release rule:",
    "\n\nIteration 7 release rule:",
    "\n\nIteration 9 release rule:",
    "\n\nIteration 10 release rule:",
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
    return [json.loads(line) for line in data.decode("utf-8").splitlines() if line.strip()], data


def root_prompt(content: str) -> str:
    positions = [content.find(marker) for marker in CONTRACT_MARKERS if marker in content]
    return content[: min(positions)].rstrip() if positions else content.rstrip()


def decision_from_target(target: str) -> str:
    match = DECISION_RE.match(target.strip())
    if not match:
        raise AssertionError("A decision target lacks the exact decision line.")
    return match.group(1)


def concise_decision_target(target: str) -> str:
    match = DECISION_RE.match(target.strip())
    if not match:
        raise AssertionError("A decision target lacks the exact decision line.")
    decision, body = match.groups()
    body = " ".join(body.split())
    if not body:
        raise AssertionError("A decision target lacks an evidence paragraph.")
    if len(body) > 460:
        cut = max(body.rfind(". ", 0, 460), body.rfind("? ", 0, 460), body.rfind("! ", 0, 460))
        body = body[: cut + 1] if cut >= 100 else body[:460].rsplit(" ", 1)[0] + "."
    if body[-1] not in ".!?":
        body += "."
    return f"Decision: {decision}.\n\n{body}"


def iteration10_prompt(user: str, *, focus_index: int, structured: bool) -> str:
    parts = [root_prompt(user), EXACTNESS_RULE]
    if structured:
        parts.append(STRUCTURED_RULE)
    parts.append(FOCUS_RULES[focus_index % len(FOCUS_RULES)])
    return "\n\n".join(parts)


def task_contract(builder, task: str) -> str:
    if task == "experiment_analysis":
        return "ExperimentAnalysisSchema"
    if task in builder.PROTOCOL_TASKS:
        return "StructuredProtocolSchema"
    return "concise_decision_text"


def resolve_failed_hashes(parent_rows: list[dict[str, Any]]) -> list[str]:
    test_hashes = [row["example_hash"] for row in parent_rows if row["split"] == "test"]
    failures = []
    for evaluation_id in FAILED_ITERATION9_EVALUATION_IDS:
        prefix = evaluation_id.rsplit("-", 1)[-1]
        matches = [value for value in test_hashes if value.startswith(prefix)]
        if len(matches) != 1:
            raise AssertionError(f"Could not resolve failed evaluation {evaluation_id}.")
        failures.append(matches[0])
    return failures


def make_variant(builder, iteration3_builder, original: dict[str, Any], *, focus_index: int) -> dict[str, Any]:
    task = original["task_type"]
    structured = task == "experiment_analysis" or task in builder.PROTOCOL_TASKS
    base_user = root_prompt(original["messages"][-2]["content"])
    if task in builder.PROTOCOL_TASKS:
        base_user = iteration3_builder.strict_protocol_prompt(base_user)
        target = original["messages"][-1]["content"]
        if not target.lstrip().startswith("{"):
            target = iteration3_builder.protocol_json_target(builder, target, original["example_hash"])
    elif task == "experiment_analysis":
        base_user = iteration3_builder.strict_pubmed_prompt(base_user, structured=True)
        target = original["messages"][-1]["content"]
        if not target.lstrip().startswith("{"):
            target = iteration3_builder.analysis_json_target(target)
    else:
        base_user = iteration3_builder.strict_pubmed_prompt(base_user, structured=False)
        target = concise_decision_target(original["messages"][-1]["content"])
    variant = iteration3_builder.make_row(
        builder,
        task=task,
        split="train",
        user_content=iteration10_prompt(base_user, focus_index=focus_index, structured=structured),
        assistant_content=target,
        group_hash=original["group_hash"],
    )
    if structured:
        prompt = "\n".join(message["content"] for message in variant["messages"][:-1])
        unsupported = iteration3_builder.unsupported_numbers(target, prompt)
        if unsupported:
            raise AssertionError(f"Focused replay has unsupported numbers: {unsupported}")
    return variant


def build_focused_variants(builder, iteration3_builder, parent_rows, failed_hashes):
    variants: list[dict[str, Any]] = []
    metadata: dict[str, dict[str, str]] = {}
    input_hashes = {row["input_hash"] for row in parent_rows}
    by_hash = {row["example_hash"]: row for row in parent_rows}
    clean = [row for row in parent_rows if not row["messages"][-1]["content"].lstrip().startswith("{")]
    buckets: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in clean:
        if row["task_type"] in builder.PUBMED_TASKS:
            buckets[(row["task_type"], decision_from_target(row["messages"][-1]["content"]))].append(row)
    for bucket in buckets.values():
        bucket.sort(key=lambda row: sha256_text(f"iteration10-focus:{row['example_hash']}"))

    def add(original, focus_index: int, role: str) -> None:
        variant = make_variant(builder, iteration3_builder, original, focus_index=focus_index)
        if variant["input_hash"] in input_hashes:
            raise AssertionError(f"Duplicate iteration-10 focused input for {role}.")
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
            if len(sources) < 3:
                raise AssertionError(f"Not enough sources for {task}/{decision} replay.")
            for replay_index in range(3):
                add(sources[replay_index], focus_index, "iteration10_balanced_decision_replay")
                focus_index += 1

    for failed_hash in failed_hashes:
        for _ in range(5):
            add(by_hash[failed_hash], focus_index, "iteration10_failed_case_replay")
            focus_index += 1

    for decision in ("yes", "no", "maybe"):
        sources = buckets[("experiment_analysis", decision)]
        eligible = []
        for source in sources:
            try:
                make_variant(builder, iteration3_builder, source, focus_index=0)
            except AssertionError as error:
                if "unsupported numbers" in str(error):
                    continue
                raise
            eligible.append(source)
        if len(eligible) < 6:
            raise AssertionError(f"Not enough structured sources for {decision} replay.")
        for replay_index in range(6):
            add(eligible[replay_index], focus_index, "iteration10_structured_analysis_replay")
            focus_index += 1

    for task in builder.PROTOCOL_TASKS:
        sources = sorted(
            (row for row in parent_rows if row["task_type"] == task),
            key=lambda row: sha256_text(f"iteration10-protocol:{row['example_hash']}"),
        )
        replay_count = 12 if task == "protocol_generation" else 11
        for replay_index in range(replay_count):
            add(sources[replay_index], focus_index, "iteration10_protocol_schema_replay")
            focus_index += 1

    expected = Counter({
        "iteration10_balanced_decision_replay": 54,
        "iteration10_failed_case_replay": 65,
        "iteration10_structured_analysis_replay": 18,
        "iteration10_protocol_schema_replay": 23,
    })
    if len(variants) != 160 or Counter(item["training_role"] for item in metadata.values()) != expected:
        raise AssertionError("Iteration-10 focused replay plan is incomplete.")
    return variants, metadata


def task_counts() -> dict[str, int]:
    return {
        "experiment_analysis": 3,
        "data_analysis": 3,
        "experiment_chat": 3,
        "experiment_comparison": 3,
        "project_chat": 2,
        "project_synthesis": 2,
        "general_chat": 2,
    }


def build_pubmed_holdouts(builder, iteration2_builder, iteration3_builder, used_pubids):
    buckets: dict[str, list[dict[str, str]]] = defaultdict(list)
    for raw in builder.fetch_pubmed_rows():
        normalized = iteration2_builder.normalize_pubmed_row(builder, raw)
        if normalized is not None and normalized["pubid"] not in used_pubids:
            buckets[normalized["decision"]].append(normalized)
    required = Counter(PUBMED_HOLDOUT_DECISIONS)
    required.update(PUBMED_HOLDOUT_DECISIONS)
    for decision, count in required.items():
        buckets[decision].sort(key=lambda row: sha256_text(f"biolab-pubmed-iteration10-selection-v1:{row['pubid']}"))
        if len(buckets[decision]) < count:
            raise AssertionError(f"Not enough unused PubMedQA rows for {decision}.")

    rows, source_manifest = [], []
    cursors = Counter()
    for split_index, split in enumerate(("validation", "test")):
        schedule_index = 0
        for task in builder.PUBMED_TASKS:
            for _ in range(task_counts()[task]):
                decision = PUBMED_HOLDOUT_DECISIONS[schedule_index]
                schedule_index += 1
                structured = task == "experiment_analysis"
                while True:
                    source = buckets[decision][cursors[decision]]
                    cursors[decision] += 1
                    base_user = builder.pubmed_prompt(task, source["question"], source["evidence"])
                    base_target = f"Decision: {source['decision']}.\n\n{source['answer']}"
                    strict_user = iteration3_builder.strict_pubmed_prompt(base_user, structured=structured)
                    if not structured:
                        break
                    candidate_target = iteration3_builder.analysis_json_target(base_target)
                    candidate_prompt = "\n".join([
                        iteration3_builder.strict_system_message(task),
                        iteration10_prompt(strict_user, focus_index=0, structured=True),
                    ])
                    if not iteration3_builder.unsupported_numbers(candidate_target, candidate_prompt):
                        break
                user = iteration10_prompt(
                    strict_user,
                    focus_index=split_index * len(PUBMED_HOLDOUT_DECISIONS) + schedule_index,
                    structured=structured,
                )
                target = iteration3_builder.analysis_json_target(base_target) if structured else base_target
                row = iteration3_builder.make_row(
                    builder,
                    task=task,
                    split=split,
                    source_group=f"{builder.PUBMED_REPO}:{source['pubid']}",
                    user_content=user,
                    assistant_content=target,
                )
                rows.append(row)
                source_manifest.append({
                    "example_hash": row["example_hash"],
                    "task_type": task,
                    "split": split,
                    "source_dataset": builder.PUBMED_REPO,
                    "source_revision": builder.PUBMED_REVISION,
                    "source_identifier": source["pubid"],
                    "source_url": f"https://pubmed.ncbi.nlm.nih.gov/{source['pubid']}/",
                    "source_license": builder.PUBMED_LICENSE,
                    "source_attribution": "PubMedQA authors and labeled-dataset annotators",
                    "response_contract": task_contract(builder, task),
                    "response_contract_version": "iteration10_schema_fidelity_v1",
                })
    if len(rows) != 36:
        raise AssertionError("Iteration-10 PubMedQA holdout count failed.")
    return rows, source_manifest


def build_protocol_holdouts(builder, iteration2_builder, iteration3_builder, used_identifiers):
    builder.assert_pinned_revision(builder.CADUCEUS_REPO, builder.CADUCEUS_REVISION)
    rows, source_manifest = [], []
    for split, task_paths in PROTOCOL_HOLDOUT_PATHS.items():
        for task, path in task_paths.items():
            if path in used_identifiers:
                raise AssertionError(f"Iteration-10 protocol holdout was already used: {path}")
            markdown_row, item = iteration2_builder.protocol_validation_row(builder, task, path)
            strict_user = iteration3_builder.strict_protocol_prompt(markdown_row["messages"][-2]["content"])
            target = iteration3_builder.protocol_json_target(builder, markdown_row["messages"][-1]["content"], path)
            row = iteration3_builder.make_row(
                builder,
                task=task,
                split=split,
                source_group=f"{builder.CADUCEUS_REPO}:{path}",
                user_content=iteration10_prompt(strict_user, focus_index=len(rows), structured=True),
                assistant_content=target,
            )
            updated = dict(item)
            updated.update({
                "example_hash": row["example_hash"],
                "split": split,
                "response_contract": "StructuredProtocolSchema",
                "response_contract_version": "iteration10_schema_fidelity_v1",
            })
            rows.append(row)
            source_manifest.append(updated)
    if len(rows) != 4:
        raise AssertionError("Iteration-10 protocol holdout count failed.")
    return rows, source_manifest


def validate_review_inputs(review_path: Path | None, gate_report_path: Path | None) -> None:
    if review_path is not None:
        actual = sha256_bytes(review_path.read_bytes())
        if actual != EXPECTED_ITERATION9_REVIEW_SHA256:
            raise AssertionError(f"Iteration-9 review changed: expected {EXPECTED_ITERATION9_REVIEW_SHA256}, found {actual}.")
        review = json.loads(review_path.read_text(encoding="utf-8"))
        if not isinstance(review, list) or len(review) != 20:
            raise AssertionError("Iteration-9 review must contain exactly 20 ratings.")
    if gate_report_path is not None:
        actual = sha256_bytes(gate_report_path.read_bytes())
        if actual != EXPECTED_ITERATION9_GATE_REPORT_SHA256:
            raise AssertionError(f"Iteration-9 gate report changed: expected {EXPECTED_ITERATION9_GATE_REPORT_SHA256}, found {actual}.")
        report = json.loads(gate_report_path.read_text(encoding="utf-8"))
        if report.get("release_gates_passed") is not False or report.get("disposition") != "quarantined":
            raise AssertionError("Iteration-9 gate report is not the quarantined result.")
        gates = report.get("gates", {})
        if len(gates) != 5 or sum(bool(value) for value in gates.values()) != 2:
            raise AssertionError("Iteration-9 gate totals do not match the audited result.")


def build_iteration(builder, iteration2_builder, iteration3_builder, iteration4_builder, parent_rows, parent_manifest):
    failed_hashes = resolve_failed_hashes(parent_rows)
    promoted_rows = [{**row, "split": "train"} for row in parent_rows]
    variants, variant_metadata = build_focused_variants(builder, iteration3_builder, parent_rows, failed_hashes)
    used_pubids = {
        str(item["source_identifier"])
        for item in parent_manifest["examples"]
        if item["source_dataset"] == builder.PUBMED_REPO
    }
    pubmed_rows, pubmed_manifest = build_pubmed_holdouts(
        builder, iteration2_builder, iteration3_builder, used_pubids
    )
    used_protocols = {
        str(item["source_identifier"])
        for item in parent_manifest["examples"]
        if item["source_dataset"] == builder.CADUCEUS_REPO
    }
    protocol_rows, protocol_manifest = build_protocol_holdouts(
        builder, iteration2_builder, iteration3_builder, used_protocols
    )
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
            "response_contract": task_contract(builder, variant["task_type"]),
            "response_contract_version": "iteration10_schema_fidelity_v1",
            **details,
        })
    manifest_examples = sorted(
        prior_manifest + variant_manifest + pubmed_manifest + protocol_manifest,
        key=lambda item: item["example_hash"],
    )
    if len(manifest_examples) != len(rows):
        raise AssertionError("Iteration-10 manifest/example count mismatch.")
    return rows, {
        "iteration_schema_version": ITERATION_SCHEMA_VERSION,
        "dataset_schema_version": builder.DATASET_SCHEMA_VERSION,
        "parent_dataset_sha256": EXPECTED_ITERATION9_DATASET_SHA256,
        "parent_review_sha256": EXPECTED_ITERATION9_REVIEW_SHA256,
        "parent_gate_report_sha256": EXPECTED_ITERATION9_GATE_REPORT_SHA256,
        "reason": (
            "Iteration 9 passed privacy and improvement gates but failed structured validity, "
            "measurement fidelity, and the 80% held-out quality gate. Every prior holdout is "
            "now training-only; 160 source-grounded corrective replays and fresh unseen "
            "holdouts target those failures."
        ),
        "holdout_note": (
            "Unused PubMedQA maybe groups remain exhausted, so fresh iteration-10 PubMedQA "
            "holdouts are balanced yes/no while training retains yes/no/maybe coverage."
        ),
        "target_provenance": (
            "No model candidate is a label; targets are expert PubMedQA answers, deterministic "
            "website-schema transformations, or grounded Caduceus excerpts."
        ),
        "failed_adapter_example_hashes": sorted(failed_hashes),
        "failed_adapter_evaluation_ids": list(FAILED_ITERATION9_EVALUATION_IDS),
        "review_summary": dict(AUDITED_ITERATION9_REVIEW_SUMMARY),
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
    parser.add_argument("--iteration9-jsonl", type=Path, required=True)
    parser.add_argument("--iteration9-manifest", type=Path, required=True)
    parser.add_argument("--iteration9-review", type=Path)
    parser.add_argument("--iteration9-gate-report", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    builder = load_module("biolab_public_builder", args.builder)
    iteration2_builder = load_module("biolab_iteration2_builder", args.iteration2_builder)
    iteration3_builder = load_module("biolab_iteration3_builder", args.iteration3_builder)
    iteration4_builder = load_module("biolab_iteration4_builder", args.iteration4_builder)
    parent_rows, parent_bytes = load_jsonl(args.iteration9_jsonl)
    actual_sha = sha256_bytes(parent_bytes)
    if actual_sha != EXPECTED_ITERATION9_DATASET_SHA256:
        raise AssertionError(f"Iteration-9 dataset changed: expected {EXPECTED_ITERATION9_DATASET_SHA256}, found {actual_sha}.")
    parent_manifest = json.loads(args.iteration9_manifest.read_text(encoding="utf-8"))
    if parent_manifest["dataset_sha256"] != actual_sha:
        raise AssertionError("Iteration-9 manifest does not match its JSONL.")
    validate_review_inputs(args.iteration9_review, args.iteration9_gate_report)
    rows, manifest = build_iteration(
        builder, iteration2_builder, iteration3_builder, iteration4_builder, parent_rows, parent_manifest
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
    print(json.dumps({
        "dataset_sha256": manifest["dataset_sha256"],
        "failed_adapter_examples": len(manifest["failed_adapter_example_hashes"]),
        "replay_counts": manifest["replay_counts"],
        **manifest["summary"],
    }, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
