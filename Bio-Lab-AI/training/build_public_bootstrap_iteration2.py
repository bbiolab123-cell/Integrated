#!/usr/bin/env python3
"""Build the second audited Bio-Lab bootstrap iteration.

The first 200-example run is treated as immutable evidence. Its prior test
examples become explicit correction/replay training examples, its untouched
validation examples become the next blind test set, and 20 previously unused
public examples become the new validation set. This prevents examples used for
gradient updates from leaking into the next test split.

No model output is used as a target. Targets remain expert PubMedQA answers or
source-derived, open-licensed protocol excerpts.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


EXPECTED_BASE_DATASET_SHA256 = (
    "cb45f070affd64009eff3acf71c247ffcaad2b9d1d743b4ecdc8478dcb076f03"
)
ITERATION_SCHEMA_VERSION = 1
PUBMED_VALIDATION_PER_DECISION = 6
PUBMED_VALIDATION_COUNTS = {
    "experiment_analysis": 3,
    "data_analysis": 3,
    "experiment_chat": 3,
    "experiment_comparison": 3,
    "project_chat": 2,
    "project_synthesis": 2,
    "general_chat": 2,
}
PROTOCOL_VALIDATION_PATHS = {
    "protocol_generation": (
        "markdown-output/a-cellprofiler-computational-pipeline-to-quantify-dhja34ie.md"
    ),
    "sop_structuring": (
        "markdown-output/an-improved-deep-learning-method-for-predicting-dn-2rdgd26.md"
    ),
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_builder(path: Path):
    spec = importlib.util.spec_from_file_location("biolab_public_builder", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not import bootstrap builder from {path}.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_jsonl(path: Path) -> tuple[list[dict[str, Any]], bytes]:
    data = path.read_bytes()
    rows = [
        json.loads(line)
        for line in data.decode("utf-8").splitlines()
        if line.strip()
    ]
    return rows, data


def normalize_pubmed_row(builder, row: dict[str, Any]) -> dict[str, str] | None:
    decision = str(row.get("final_decision", "")).strip().lower()
    question = builder.clean_text(str(row.get("question", "")))
    answer = builder.clean_text(str(row.get("long_answer", "")))
    context = row.get("context") or {}
    contexts = context.get("contexts") if isinstance(context, dict) else None
    if decision not in {"yes", "no", "maybe"}:
        return None
    if not question or not answer or not isinstance(contexts, list):
        return None
    evidence = builder.clean_text(
        "\n".join(str(item) for item in contexts if str(item).strip())
    )
    if not evidence:
        return None
    if len(question) + len(answer) + len(evidence) > builder.MAX_SOURCE_CHARS:
        return None
    return {
        "pubid": str(row["pubid"]),
        "question": question,
        "answer": answer,
        "evidence": evidence,
        "decision": decision,
    }


def build_pubmed_validation(
    builder,
    used_pubids: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, str]]] = defaultdict(list)
    for raw in builder.fetch_pubmed_rows():
        normalized = normalize_pubmed_row(builder, raw)
        if normalized is None or normalized["pubid"] in used_pubids:
            continue
        buckets[normalized["decision"]].append(normalized)

    selected: list[dict[str, str]] = []
    for decision in ("yes", "no", "maybe"):
        candidates = sorted(
            buckets[decision],
            key=lambda row: sha256_text(
                f"biolab-pubmed-iteration2-selection-v1:{row['pubid']}"
            ),
        )
        if len(candidates) < PUBMED_VALIDATION_PER_DECISION:
            raise AssertionError(
                f"Not enough unused PubMedQA rows for decision={decision}."
            )
        selected.extend(candidates[:PUBMED_VALIDATION_PER_DECISION])
    selected.sort(
        key=lambda row: sha256_text(
            f"biolab-pubmed-iteration2-order-v1:{row['pubid']}"
        )
    )

    examples: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    cursor = 0
    for task in builder.PUBMED_TASKS:
        count = PUBMED_VALIDATION_COUNTS[task]
        for source in selected[cursor : cursor + count]:
            row = builder.public_row(
                task=task,
                split="validation",
                source_group=f"{builder.PUBMED_REPO}:{source['pubid']}",
                user_content=builder.pubmed_prompt(
                    task, source["question"], source["evidence"]
                ),
                assistant_content=(
                    f"Decision: {source['decision']}.\n\n{source['answer']}"
                ),
            )
            examples.append(row)
            manifest.append(
                {
                    "example_hash": row["example_hash"],
                    "task_type": task,
                    "split": "validation",
                    "source_dataset": builder.PUBMED_REPO,
                    "source_revision": builder.PUBMED_REVISION,
                    "source_identifier": source["pubid"],
                    "source_url": (
                        f"https://pubmed.ncbi.nlm.nih.gov/{source['pubid']}/"
                    ),
                    "source_license": builder.PUBMED_LICENSE,
                    "source_attribution": (
                        "PubMedQA authors and labeled-dataset annotators"
                    ),
                }
            )
        cursor += count
    if cursor != 18:
        raise AssertionError("Iteration-2 PubMedQA validation allocation failed.")
    return examples, manifest


def protocol_validation_row(builder, task: str, path: str):
    raw_protocol = builder.download_protocol(path)
    public_attribution = builder.protocol_public_attribution(raw_protocol)
    markdown = builder.clean_protocol_markdown(raw_protocol)
    markdown = builder.deidentify_protocol_preamble(markdown, path)
    title = builder.protocol_title(markdown, path)
    goal = builder.protocol_goal(markdown)
    training_markdown = builder.protocol_training_excerpt(markdown)
    source_notes = builder.protocol_plain_notes(training_markdown)
    sections = builder.protocol_section_names(training_markdown)
    if task == "protocol_generation":
        user_content = (
            "Create a structured protocol using only these source-derived requirements. "
            "Retain supplied quantities and safety notes; do not invent missing values.\n\n"
            f"Title: {title}\nGoal: {goal}\n"
            f"Required sections: {', '.join(sections) or 'Goal, materials, procedure, safety'}\n"
            f"Source requirements:\n{source_notes}"
        )
    else:
        user_content = (
            "Convert these source-derived unstructured notes into a clear SOP. Preserve "
            "the supplied scientific values and safety language.\n\n"
            f"Procedure title: {title}\nSource notes:\n{source_notes}"
        )
    if source_notes not in user_content:
        raise AssertionError(f"Protocol {path} target is not grounded in its input.")
    row = builder.public_row(
        task=task,
        split="validation",
        source_group=f"{builder.CADUCEUS_REPO}:{path}",
        user_content=user_content,
        assistant_content=training_markdown,
    )
    manifest = {
        "example_hash": row["example_hash"],
        "task_type": task,
        "split": "validation",
        "source_dataset": builder.CADUCEUS_REPO,
        "source_revision": builder.CADUCEUS_REVISION,
        "source_identifier": path,
        "source_url": (
            f"https://huggingface.co/datasets/{builder.CADUCEUS_REPO}/blob/"
            f"{builder.CADUCEUS_REVISION}/{path}"
        ),
        "source_license": builder.CADUCEUS_LICENSE,
        "source_attribution": (
            "Caduceus Project Dataset contributors and original protocols.io "
            "protocol authors; metadata remains in this private audit manifest."
        ),
        "public_attribution_excerpt": public_attribution,
        "training_excerpt_sha256": sha256_text(training_markdown),
        "training_excerpt_chars": len(training_markdown),
    }
    return row, manifest


def build_protocol_validation(builder):
    builder.assert_pinned_revision(
        builder.CADUCEUS_REPO, builder.CADUCEUS_REVISION
    )
    examples: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    for task, path in PROTOCOL_VALIDATION_PATHS.items():
        row, item = protocol_validation_row(builder, task, path)
        examples.append(row)
        manifest.append(item)
    return examples, manifest


def validate_iteration(rows: list[dict[str, Any]], builder) -> dict[str, Any]:
    if len(rows) != 220:
        raise AssertionError(f"Expected 220 examples, found {len(rows)}.")
    split_counts = Counter(row["split"] for row in rows)
    if split_counts != Counter({"train": 180, "validation": 20, "test": 20}):
        raise AssertionError(f"Unexpected iteration-2 splits: {dict(split_counts)}")

    input_hashes: set[str] = set()
    example_hashes: set[str] = set()
    group_splits: dict[str, set[str]] = defaultdict(set)
    task_counts = Counter()
    split_tasks: dict[str, set[str]] = defaultdict(set)
    for index, row in enumerate(rows, start=1):
        if row["input_hash"] in input_hashes:
            raise AssertionError(f"Duplicate input at row {index}.")
        if row["example_hash"] in example_hashes:
            raise AssertionError(f"Duplicate example at row {index}.")
        input_hashes.add(row["input_hash"])
        example_hashes.add(row["example_hash"])
        group_splits[row["group_hash"]].add(row["split"])
        task_counts[row["task_type"]] += 1
        split_tasks[row["split"]].add(row["task_type"])
        if row["task_type"] in builder.PROTOCOL_TASKS:
            target = row["messages"][-1]["content"]
            if builder.protocol_plain_notes(target) not in row["messages"][-2]["content"]:
                raise AssertionError(
                    f"Protocol target at row {index} contains absent source details."
                )
    if any(len(splits) != 1 for splits in group_splits.values()):
        raise AssertionError("A public source group leaked across splits.")
    required_tasks = set(builder.ALL_TASKS)
    for split in ("validation", "test"):
        if split_tasks[split] != required_tasks:
            raise AssertionError(
                f"{split} lacks task coverage: "
                f"{sorted(required_tasks - split_tasks[split])}"
            )
    return {
        "examples": len(rows),
        "split_counts": dict(sorted(split_counts.items())),
        "task_counts": dict(sorted(task_counts.items())),
        "holdout_task_coverage": {
            split: sorted(split_tasks[split])
            for split in ("validation", "test")
        },
        "provenance": "public_licensed",
    }


def build_iteration(
    builder,
    base_rows: list[dict[str, Any]],
    base_manifest: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    promoted_rows: list[dict[str, Any]] = []
    for original in base_rows:
        row = dict(original)
        if original["split"] == "test":
            row["split"] = "train"
        elif original["split"] == "validation":
            row["split"] = "test"
        promoted_rows.append(row)

    used_pubids = {
        str(item["source_identifier"])
        for item in base_manifest["examples"]
        if item["source_dataset"] == builder.PUBMED_REPO
    }
    pubmed_rows, pubmed_manifest = build_pubmed_validation(builder, used_pubids)
    protocol_rows, protocol_manifest = build_protocol_validation(builder)
    rows = sorted(
        promoted_rows + pubmed_rows + protocol_rows,
        key=lambda row: row["example_hash"],
    )
    summary = validate_iteration(rows, builder)

    split_by_hash = {row["example_hash"]: row["split"] for row in rows}
    prior_manifest = []
    for original in base_manifest["examples"]:
        item = dict(original)
        item["split"] = split_by_hash[item["example_hash"]]
        prior_manifest.append(item)
    manifest_examples = sorted(
        prior_manifest + pubmed_manifest + protocol_manifest,
        key=lambda item: item["example_hash"],
    )
    return rows, {
        "iteration_schema_version": ITERATION_SCHEMA_VERSION,
        "dataset_schema_version": builder.DATASET_SCHEMA_VERSION,
        "parent_dataset_sha256": EXPECTED_BASE_DATASET_SHA256,
        "reason": (
            "First adapter failed blind gates; old test examples became explicit "
            "source-backed correction/replay training examples, untouched old "
            "validation became test, and new public examples became validation."
        ),
        "target_provenance": (
            "No model output is a label; targets are expert PubMedQA answers or "
            "grounded Caduceus protocol excerpts."
        ),
        "summary": summary,
        "sources": base_manifest["sources"],
        "examples": manifest_examples,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--builder", type=Path, required=True)
    parser.add_argument("--base-jsonl", type=Path, required=True)
    parser.add_argument("--base-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    builder = load_builder(args.builder)
    base_rows, base_bytes = load_jsonl(args.base_jsonl)
    actual_sha = sha256_bytes(base_bytes)
    if actual_sha != EXPECTED_BASE_DATASET_SHA256:
        raise AssertionError(
            f"Base dataset changed: expected {EXPECTED_BASE_DATASET_SHA256}, "
            f"found {actual_sha}."
        )
    base_manifest = json.loads(args.base_manifest.read_text(encoding="utf-8"))
    if base_manifest["dataset_sha256"] != actual_sha:
        raise AssertionError("Base manifest does not match the base JSONL.")

    rows, manifest = build_iteration(builder, base_rows, base_manifest)
    data = (
        "\n".join(canonical_json(row) for row in rows) + "\n"
    ).encode("utf-8")
    manifest["dataset_sha256"] = sha256_bytes(data)
    args.output.write_bytes(data)
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "dataset_sha256": manifest["dataset_sha256"],
                **manifest["summary"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
