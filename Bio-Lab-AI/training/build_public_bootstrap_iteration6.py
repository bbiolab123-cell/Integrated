#!/usr/bin/env python3
"""Build the sixth audited BioLab public-bootstrap iteration.

Iteration 6 promotes every iteration-5 holdout to training-only data, adds
balanced source-grounded decision/schema replays, and creates fresh unseen
validation and test groups. Model candidates are never used as labels.
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


EXPECTED_ITERATION5_DATASET_SHA256 = (
    "73c532c5b976df76ddf480ff9c755303d8abb52e5358db1c7fbbae58480d9847"
)
EXPECTED_ITERATION5_REVIEW_SHA256 = (
    "ba22c3494b88996540b84b4270a89a595e995dc184a934fd51648a54feb59392"
)
EXPECTED_ITERATION5_GATE_REPORT_SHA256 = (
    "03ecf177ae5c90f96522602b6c0cb64fe0bd6aa6c34efdda994637a4b7d7126d"
)
FAILED_ITERATION5_EVALUATION_IDS = (
    "eval-0001-00120e720159",
    "eval-0006-3f49344a7161",
    "eval-0009-7bdd45cbbefe",
    "eval-0011-80c551fa62ba",
    "eval-0012-8d4027427f5a",
    "eval-0013-a936f276af95",
    "eval-0014-ab9be915edb8",
    "eval-0015-c476990fe763",
    "eval-0016-d5b4ea2a04f0",
    "eval-0018-db2dc9bee95a",
    "eval-0019-e4ba0be5ccda",
    "eval-0020-e9d44e819b08",
)
AUDITED_ITERATION5_REVIEW_SUMMARY = {
    "review_sha256": EXPECTED_ITERATION5_REVIEW_SHA256,
    "gate_report_sha256": EXPECTED_ITERATION5_GATE_REPORT_SHA256,
    "records": 20,
    "strictly_blind_records": 19,
    "adapter_approval_count": 8,
    "adapter_rating_4_or_5_count": 8,
    "adapter_measurement_fidelity_count": 19,
    "adapter_privacy_pass_count": 20,
    "adapter_structured_count": 5,
    "adapter_structured_valid_count": 4,
    "failed_adapter_examples_promoted_for_correction": 12,
    "review_provenance": (
        "AI-assisted scientific review performed by Codex at the BioLab owner's "
        "explicit request; not a human scientist/owner rating."
    ),
}
ITERATION_SCHEMA_VERSION = 5
TOTAL_EXAMPLES = 680
EXPECTED_SPLITS = Counter({"train": 640, "validation": 20, "test": 20})
UNSTRUCTURED_VARIANTS_PER_DECISION = 6
STRUCTURED_ANALYSIS_VARIANTS_PER_DECISION = 12
PROTOCOL_VARIANTS_PER_TASK = 8
PUBMED_HOLDOUT_DECISIONS = (
    "yes",
    "no",
    "maybe",
    "yes",
    "no",
    "yes",
    "no",
    "maybe",
    "yes",
    "no",
    "yes",
    "no",
    "maybe",
    "yes",
    "no",
    "yes",
    "no",
    "maybe",
)
PROTOCOL_HOLDOUT_PATHS = {
    "validation": {
        "protocol_generation": (
            "markdown-output/automated-procedure-for-estimation-of-methylation-b3ptqmnn.md"
        ),
        "sop_structuring": (
            "markdown-output/combined-metagenomic-metatranscriptomic-pipeline-f-d7m9k5.md"
        ),
    },
    "test": {
        "protocol_generation": (
            "markdown-output/analysis-of-the-time-evolution-of-auditory-steady-wejfbcn.md"
        ),
        "sop_structuring": (
            "markdown-output/generating-ct-cut-off-values-using-gblocks-gene-fr-c8pyzvpw.md"
        ),
    },
}
EXACTNESS_RULE = (
    "Iteration 6 release rule: Return a complete answer within the requested schema. "
    "For decision tasks, the first line must be exactly Decision: yes., Decision: no., "
    "or Decision: maybe. Preserve the source's yes/no/maybe conclusion even when the "
    "evidence paragraph is cautious. Copy any quoted number and unit character-for-"
    "character from the supplied source; omit ambiguous values. Never invent a "
    "measurement, procedure, control, material, or clinical conclusion."
)
STRUCTURED_RULE = (
    "Structured-output rule: Emit one complete JSON object and nothing else. Use every "
    "required key with the exact field types shown in the response contract. Keep each "
    "field concise so the closing brace is always produced. If the source lacks an "
    "actionable step or material, say that explicitly instead of inventing one."
)
FOCUS_RULES = (
    "Answer the research question directly before summarizing supporting evidence.",
    "Preserve explicit negation; a reported lack of association must not become an association.",
    "Use maybe only when the labeled source conclusion is uncertain or conditional.",
    "Do not replace a source-supported yes or no with generic caution.",
    "Separate an observed association from a causal claim.",
    "Prefer one short evidence paragraph over an exhaustive restatement of the source.",
    "Do not introduce study counts, percentages, dates, or units unless copied literally.",
    "Finish every sentence and close every JSON array and object.",
    "Keep review notes and suggestions source-bounded and operationally modest.",
    "When the excerpt is non-actionable, return explicit not-specified placeholders.",
    "Use arrays for array fields and strings for string fields without substitutions.",
    "Recheck the first decision token and final closing delimiter before responding.",
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


def decision_from_target(target: str) -> str:
    match = DECISION_RE.match(target.strip())
    if not match:
        raise AssertionError("A balanced decision replay lacks the exact decision line.")
    return match.group(1)


def concise_decision_target(target: str) -> str:
    match = DECISION_RE.match(target.strip())
    if not match:
        raise AssertionError("A decision replay target lacks the exact decision line.")
    decision, body = match.groups()
    body = " ".join(body.split())
    if not body:
        raise AssertionError("A decision replay target lacks an evidence paragraph.")
    if len(body) > 480:
        cut = max(
            body.rfind(". ", 0, 480),
            body.rfind("? ", 0, 480),
            body.rfind("! ", 0, 480),
        )
        body = body[: cut + 1] if cut >= 100 else body[:480].rsplit(" ", 1)[0] + "."
    if body[-1] not in ".!?":
        body += "."
    return f"Decision: {decision}.\n\n{body}"


def iteration6_prompt(user_content: str, focus_index: int = 0, structured: bool = False) -> str:
    parts = [user_content.rstrip(), EXACTNESS_RULE, FOCUS_RULES[focus_index % len(FOCUS_RULES)]]
    if structured:
        parts.insert(2, STRUCTURED_RULE)
    return "\n\n".join(parts)


def original_source_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        row
        for row in rows
        if "Response contract:" not in row["messages"][-2]["content"]
        and "Return valid JSON only" not in row["messages"][-2]["content"]
        and "Iteration 5 exactness rule" not in row["messages"][-2]["content"]
        and not row["messages"][-1]["content"].lstrip().startswith("{")
    ]


def build_balanced_variants(
    builder,
    iteration3_builder,
    parent_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    variants: list[dict[str, Any]] = []
    parent_by_variant: dict[str, str] = {}
    input_hashes = {row["input_hash"] for row in parent_rows}
    clean = original_source_rows(parent_rows)
    by_task_decision: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in clean:
        if row["task_type"] in builder.PUBMED_TASKS:
            by_task_decision[(row["task_type"], decision_from_target(row["messages"][-1]["content"]))].append(row)
    for bucket in by_task_decision.values():
        bucket.sort(key=lambda row: sha256_text(f"iteration6-balanced-source:{row['example_hash']}"))

    unstructured_tasks = [task for task in builder.PUBMED_TASKS if task != "experiment_analysis"]
    for task in unstructured_tasks:
        for decision in ("yes", "no", "maybe"):
            sources = by_task_decision[(task, decision)]
            if not sources:
                raise AssertionError(f"No source for iteration-6 {task}/{decision} replay.")
            for index in range(UNSTRUCTURED_VARIANTS_PER_DECISION):
                original = sources[index % len(sources)]
                user = iteration3_builder.strict_pubmed_prompt(
                    original["messages"][-2]["content"], structured=False
                )
                user = iteration6_prompt(user, focus_index=index, structured=False)
                target = concise_decision_target(original["messages"][-1]["content"])
                variant = iteration3_builder.make_row(
                    builder,
                    task=task,
                    split="train",
                    user_content=user,
                    assistant_content=target,
                    group_hash=original["group_hash"],
                )
                if variant["input_hash"] in input_hashes:
                    raise AssertionError(f"Duplicate balanced input for {task}/{decision}/{index}.")
                input_hashes.add(variant["input_hash"])
                variants.append(variant)
                parent_by_variant[variant["example_hash"]] = original["example_hash"]

    for decision in ("yes", "no", "maybe"):
        sources = by_task_decision[("experiment_analysis", decision)]
        if not sources:
            raise AssertionError(f"No source for structured analysis/{decision} replay.")
        eligible_sources: list[tuple[dict[str, Any], str]] = []
        for source in sources:
            target = iteration3_builder.analysis_json_target(source["messages"][-1]["content"])
            source_user = iteration3_builder.strict_pubmed_prompt(
                source["messages"][-2]["content"], structured=True
            )
            prompt = "\n".join([source["messages"][0]["content"], source_user])
            if not iteration3_builder.unsupported_numbers(target, prompt):
                eligible_sources.append((source, target))
        if not eligible_sources:
            raise AssertionError(
                f"No number-faithful source for structured analysis/{decision} replay."
            )
        for index in range(STRUCTURED_ANALYSIS_VARIANTS_PER_DECISION):
            original, target = eligible_sources[index % len(eligible_sources)]
            user = iteration3_builder.strict_pubmed_prompt(
                original["messages"][-2]["content"], structured=True
            )
            user = iteration6_prompt(user, focus_index=index, structured=True)
            variant = iteration3_builder.make_row(
                builder,
                task="experiment_analysis",
                split="train",
                user_content=user,
                assistant_content=target,
                group_hash=original["group_hash"],
            )
            if variant["input_hash"] in input_hashes:
                raise AssertionError(f"Duplicate structured analysis input for {decision}/{index}.")
            input_hashes.add(variant["input_hash"])
            variants.append(variant)
            parent_by_variant[variant["example_hash"]] = original["example_hash"]

    protocol_sources = [row for row in clean if row["task_type"] in builder.PROTOCOL_TASKS]
    for task in builder.PROTOCOL_TASKS:
        sources = sorted(
            (row for row in protocol_sources if row["task_type"] == task),
            key=lambda row: sha256_text(f"iteration6-protocol-source:{row['example_hash']}"),
        )
        if not sources:
            raise AssertionError(f"No source for iteration-6 {task} replay.")
        for index in range(PROTOCOL_VARIANTS_PER_TASK):
            original = sources[index % len(sources)]
            user = iteration3_builder.strict_protocol_prompt(original["messages"][-2]["content"])
            user = iteration6_prompt(user, focus_index=index, structured=True)
            target = iteration3_builder.protocol_json_target(
                builder,
                original["messages"][-1]["content"],
                f"iteration6-{original['example_hash']}",
            )
            prompt = "\n".join([original["messages"][0]["content"], user])
            unsupported = iteration3_builder.unsupported_numbers(target, prompt)
            if unsupported:
                raise AssertionError(f"Protocol replay contains unsupported numbers: {unsupported}")
            variant = iteration3_builder.make_row(
                builder,
                task=task,
                split="train",
                user_content=user,
                assistant_content=target,
                group_hash=original["group_hash"],
            )
            if variant["input_hash"] in input_hashes:
                raise AssertionError(f"Duplicate protocol input for {task}/{index}.")
            input_hashes.add(variant["input_hash"])
            variants.append(variant)
            parent_by_variant[variant["example_hash"]] = original["example_hash"]

    if len(variants) != 160:
        raise AssertionError(f"Expected 160 iteration-6 variants, found {len(variants)}.")
    return variants, parent_by_variant


def rebuild_holdout_prompts(
    builder,
    iteration3_builder,
    rows: list[dict[str, Any]],
    manifest: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rebuilt_rows: list[dict[str, Any]] = []
    rebuilt_manifest: list[dict[str, Any]] = []
    for index, (row, item) in enumerate(zip(rows, manifest, strict=True)):
        structured = row["task_type"] == "experiment_analysis"
        rebuilt = iteration3_builder.make_row(
            builder,
            task=row["task_type"],
            split=row["split"],
            user_content=iteration6_prompt(
                row["messages"][-2]["content"], focus_index=index, structured=structured
            ),
            assistant_content=row["messages"][-1]["content"],
            group_hash=row["group_hash"],
        )
        updated = dict(item)
        updated["example_hash"] = rebuilt["example_hash"]
        updated["response_contract_version"] = "iteration6_balanced_complete_v1"
        rebuilt_rows.append(rebuilt)
        rebuilt_manifest.append(updated)
    return rebuilt_rows, rebuilt_manifest


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
    required = Counter(PUBMED_HOLDOUT_DECISIONS)
    required.update(PUBMED_HOLDOUT_DECISIONS)
    for decision, count in required.items():
        buckets[decision].sort(
            key=lambda row: sha256_text(
                f"biolab-pubmed-iteration6-selection-v1:{row['pubid']}"
            )
        )
        if len(buckets[decision]) < count:
            raise AssertionError(
                f"Not enough unused PubMedQA rows for {decision}: "
                f"need {count}, found {len(buckets[decision])}."
            )

    rows: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    cursors = Counter()
    for split_index, split in enumerate(("validation", "test")):
        schedule_index = 0
        for task in builder.PUBMED_TASKS:
            count = iteration4_builder_counts()[task]
            for _ in range(count):
                decision = PUBMED_HOLDOUT_DECISIONS[schedule_index]
                source = buckets[decision][cursors[decision]]
                cursors[decision] += 1
                schedule_index += 1
                base_user = builder.pubmed_prompt(task, source["question"], source["evidence"])
                base_target = f"Decision: {source['decision']}.\n\n{source['answer']}"
                structured = task == "experiment_analysis"
                user = iteration3_builder.strict_pubmed_prompt(base_user, structured=structured)
                user = iteration6_prompt(
                    user,
                    focus_index=split_index * len(PUBMED_HOLDOUT_DECISIONS) + schedule_index,
                    structured=structured,
                )
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
                        "response_contract_version": "iteration6_balanced_complete_v1",
                    }
                )
        if schedule_index != len(PUBMED_HOLDOUT_DECISIONS):
            raise AssertionError(f"Iteration-6 {split} PubMedQA allocation failed.")
    if len(rows) != 36 or cursors != required:
        raise AssertionError("Iteration-6 PubMedQA holdout totals failed.")
    return rows, manifest


def iteration4_builder_counts() -> dict[str, int]:
    return {
        "experiment_analysis": 3,
        "data_analysis": 3,
        "experiment_chat": 3,
        "experiment_comparison": 3,
        "project_chat": 2,
        "project_synthesis": 2,
        "general_chat": 2,
    }


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
                raise AssertionError(f"Iteration-6 protocol holdout was already used: {path}")
            markdown_row, item = iteration2_builder.protocol_validation_row(builder, task, path)
            user = iteration3_builder.strict_protocol_prompt(markdown_row["messages"][-2]["content"])
            user = iteration6_prompt(user, focus_index=len(rows), structured=True)
            target = iteration3_builder.protocol_json_target(
                builder, markdown_row["messages"][-1]["content"], path
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
                    "response_contract_version": "iteration6_balanced_complete_v1",
                }
            )
            rows.append(row)
            manifest.append(updated)
    if len(rows) != 4:
        raise AssertionError("Iteration-6 protocol holdout count failed.")
    return rows, manifest


def validate_review_inputs(review_path: Path | None, gate_report_path: Path | None) -> None:
    if review_path is not None:
        actual = sha256_bytes(review_path.read_bytes())
        if actual != EXPECTED_ITERATION5_REVIEW_SHA256:
            raise AssertionError(
                f"Iteration-5 review changed: expected {EXPECTED_ITERATION5_REVIEW_SHA256}, found {actual}."
            )
    if gate_report_path is not None:
        actual = sha256_bytes(gate_report_path.read_bytes())
        if actual != EXPECTED_ITERATION5_GATE_REPORT_SHA256:
            raise AssertionError(
                "Iteration-5 gate report changed: "
                f"expected {EXPECTED_ITERATION5_GATE_REPORT_SHA256}, found {actual}."
            )
        report = json.loads(gate_report_path.read_text(encoding="utf-8"))
        if report.get("release_accepted") or report.get("disposition") != "quarantined":
            raise AssertionError("Iteration-5 gate report is not the quarantined result.")
        if report.get("passed_gate_count") != 2 or report.get("gate_count") != 5:
            raise AssertionError("Iteration-5 gate totals do not match the audited result.")


def failed_parent_hashes(parent_rows: list[dict[str, Any]]) -> list[str]:
    test_hashes = [row["example_hash"] for row in parent_rows if row["split"] == "test"]
    failures: list[str] = []
    for evaluation_id in FAILED_ITERATION5_EVALUATION_IDS:
        prefix = evaluation_id.rsplit("-", 1)[-1]
        matches = [value for value in test_hashes if value.startswith(prefix)]
        if len(matches) != 1:
            raise AssertionError(f"Could not resolve failed evaluation {evaluation_id} to one test row.")
        failures.append(matches[0])
    return sorted(failures)


def build_iteration(
    builder,
    iteration2_builder,
    iteration3_builder,
    iteration4_builder,
    parent_rows: list[dict[str, Any]],
    parent_manifest: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    failures = failed_parent_hashes(parent_rows)
    promoted_rows = []
    for original in parent_rows:
        row = dict(original)
        row["split"] = "train"
        promoted_rows.append(row)

    balanced_variants, parent_by_variant = build_balanced_variants(
        builder, iteration3_builder, parent_rows
    )
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
    rows = sorted(
        promoted_rows + balanced_variants + pubmed_rows + protocol_rows,
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
    variant_manifest = []
    for variant in balanced_variants:
        parent_hash = parent_by_variant[variant["example_hash"]]
        source_item = manifest_by_hash[parent_hash]
        task = variant["task_type"]
        variant_manifest.append(
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
                "response_contract_version": "iteration6_balanced_complete_v1",
                "training_role": "iteration6_balanced_contract_replay",
                "parent_example_hash": parent_hash,
            }
        )
    manifest_examples = sorted(
        prior_manifest + variant_manifest + pubmed_manifest + protocol_manifest,
        key=lambda item: item["example_hash"],
    )
    if len(manifest_examples) != len(rows):
        raise AssertionError("Iteration-6 manifest/example count mismatch.")
    return rows, {
        "iteration_schema_version": ITERATION_SCHEMA_VERSION,
        "dataset_schema_version": builder.DATASET_SCHEMA_VERSION,
        "parent_dataset_sha256": EXPECTED_ITERATION5_DATASET_SHA256,
        "parent_review_sha256": EXPECTED_ITERATION5_REVIEW_SHA256,
        "parent_gate_report_sha256": EXPECTED_ITERATION5_GATE_REPORT_SHA256,
        "reason": (
            "Iteration 5 improved over the base model but failed structured validity, "
            "exact measurement fidelity, and the 80%-quality gate. Every prior holdout "
            "is training-only; 160 balanced source-grounded contract replays and fresh "
            "unseen holdouts are added."
        ),
        "target_provenance": (
            "No model candidate is a label; targets are expert PubMedQA answers, "
            "deterministic website-schema transformations, or grounded Caduceus excerpts."
        ),
        "failed_adapter_example_hashes": failures,
        "failed_adapter_evaluation_ids": list(FAILED_ITERATION5_EVALUATION_IDS),
        "review_summary": dict(AUDITED_ITERATION5_REVIEW_SUMMARY),
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
    parser.add_argument("--iteration5-jsonl", type=Path, required=True)
    parser.add_argument("--iteration5-manifest", type=Path, required=True)
    parser.add_argument("--iteration5-review", type=Path)
    parser.add_argument("--iteration5-gate-report", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    builder = load_module("biolab_public_builder", args.builder)
    iteration2_builder = load_module("biolab_iteration2_builder", args.iteration2_builder)
    iteration3_builder = load_module("biolab_iteration3_builder", args.iteration3_builder)
    iteration4_builder = load_module("biolab_iteration4_builder", args.iteration4_builder)
    parent_rows, parent_bytes = load_jsonl(args.iteration5_jsonl)
    actual_sha = sha256_bytes(parent_bytes)
    if actual_sha != EXPECTED_ITERATION5_DATASET_SHA256:
        raise AssertionError(
            "Iteration-5 dataset changed: "
            f"expected {EXPECTED_ITERATION5_DATASET_SHA256}, found {actual_sha}."
        )
    parent_manifest = json.loads(args.iteration5_manifest.read_text(encoding="utf-8"))
    if parent_manifest["dataset_sha256"] != actual_sha:
        raise AssertionError("Iteration-5 manifest does not match its JSONL.")
    validate_review_inputs(args.iteration5_review, args.iteration5_gate_report)
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
                "failed_adapter_examples": len(manifest["failed_adapter_example_hashes"]),
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
