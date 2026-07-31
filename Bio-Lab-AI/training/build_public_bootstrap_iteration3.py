#!/usr/bin/env python3
"""Build the third audited Bio-Lab public-bootstrap iteration.

Iteration 3 turns every iteration-2 holdout into training data because both
validation and test influenced the prior run or its release decision. It then:

* adds strict, concise response-contract variants for 40 existing train rows;
* creates 20 new validation and 20 new test rows from previously unused public
  source groups; and
* uses the website's current JSON contracts for experiment analysis, protocol
  generation, and SOP structuring.

Targets remain deterministic transformations of expert PubMedQA answers or
grounded Caduceus protocol excerpts. No model output is used as a label.
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


EXPECTED_ITERATION2_DATASET_SHA256 = (
    "bcc849898fdbc3afbdd0efbffcddf9eb8c3e0d71428c83bdaa17193f78fca38c"
)
EXPECTED_ITERATION2_REVIEW_SHA256 = (
    "4a6e229a94f58ca38822e545964f35cfa77d00816f53161c014680f5e81a24ec"
)
AUDITED_ITERATION2_FAILED_HASHES = (
    "187dc918614764ca3f7f85e82baf93376960006e59a5335edc20be9629a09e44",
    "367ba5b89438e732e6591ba897666190220a2712286184674fff8f0ebd8cab73",
    "440cc45157a404787c328b3d2f715bf1a1ed68010868cdd2013d2d5781895c81",
    "49700b1d651dc9381de7142165f5f8123701f6ee4c1e41062e8d6aaa9b10ea43",
    "4f02f4dd5e025cd5e4dd31b8ba3a25cc7553d695ac60948e4e7c9ba2e00a90a0",
    "7240257117f16a860d5f7a123423d238d242920c5974f5f4652f811bfe57db20",
    "73b546c1e886b40f3da9489ba1b63a71d61c280a2a3273fba0f25a1a544d1677",
    "7b79d2f882226dee73eaf3805f17197f021fbfd4497e3a6cd6f3ad15f3a7a1ff",
    "829d393e8b88889738e9203ce4d49fef9740416c2a0bedf62b9f3d23d86f1623",
    "8b5b967c75b4a871f09190235ca2d871744e24ef5bb568900a7c845477cb59c7",
    "9dd7790592379bc09ff1078d2c6cb33edc81ac917b50f75a0665dd2b3436acea",
    "ab4e8b3ef0bb648b1a25a6dd84e155078aa1ee9d4f7ec80965ccef66506ffddf",
    "c56b266b45e63fcf019775ef3344f1a658ff1338a38ba5a16d4f51c8fad71055",
    "c5b894af7bf12a89fa36b090f2269d5166d8cbb1e92856d2b740dfef82aba8b2",
    "ff202f6bba6a37bc389b8c17cfc3b1f1b3e02a7e5d9bd91f2d297dbfc437c582",
)
AUDITED_ITERATION2_REVIEW_SUMMARY = {
    "review_sha256": EXPECTED_ITERATION2_REVIEW_SHA256,
    "records": 20,
    "adapter_approval_count": 5,
    "adapter_rating_4_or_5_count": 5,
    "adapter_measurement_fidelity_count": 18,
    "failed_adapter_examples_promoted_for_correction": 15,
}
ITERATION_SCHEMA_VERSION = 2
SOURCE_SCHEMA_VERSION = 3
STRICT_VARIANT_COUNTS = {
    "experiment_analysis": 6,
    "data_analysis": 5,
    "experiment_chat": 5,
    "experiment_comparison": 5,
    "project_chat": 5,
    "project_synthesis": 5,
    "general_chat": 5,
    "protocol_generation": 2,
    "sop_structuring": 2,
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
            "markdown-output/high-quality-dna-extraction-protocol-from-recalcit-i8jchun.md"
        ),
        "sop_structuring": (
            "markdown-output/fitting-pdb-files-to-saxs-data-using-foxs-web-serv-bd3di8i6.md"
        ),
    },
    "test": {
        "protocol_generation": (
            "markdown-output/cellprofiler-pipeline-to-obtain-pearson-39-s-corre-cqnivvce.md"
        ),
        "sop_structuring": (
            "markdown-output/field-survey-of-the-population-dynamics-of-common-mmyc47w.md"
        ),
    },
}
ANALYSIS_KEYS = {"summary", "suggestions"}
ANALYSIS_SUGGESTION_KEYS = {
    "title",
    "variable_to_change",
    "rationale",
    "expected_outcome",
    "confidence",
}
PROTOCOL_KEYS = {
    "objective",
    "materials",
    "controls",
    "plate_layout",
    "steps",
    "expected_readout",
    "suggested_analysis",
    "review_notes",
    "changes_summary",
}
NUMBER_RE = re.compile(
    r"(?<![A-Za-z])[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?%?"
)


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
    rows = [
        json.loads(line)
        for line in data.decode("utf-8").splitlines()
        if line.strip()
    ]
    return rows, data


def strict_system_message(task: str) -> str:
    return (
        f"<TASK={task}>\n"
        "Use only the supplied open-licensed scientific source. "
        "Do not invent measurements, procedures, controls, or clinical certainty. "
        "Preserve uncertainty and distinguish reported evidence from inference. "
        "Return one complete, concise response and stop after the requested conclusion."
    )


def make_row(
    builder,
    *,
    task: str,
    split: str,
    user_content: str,
    assistant_content: str,
    source_group: str | None = None,
    group_hash: str | None = None,
) -> dict[str, Any]:
    if (source_group is None) == (group_hash is None):
        raise AssertionError("Provide exactly one of source_group or group_hash.")
    messages = [
        {"role": "system", "content": strict_system_message(task)},
        {"role": "user", "content": builder.clean_text(user_content)},
        {"role": "assistant", "content": builder.clean_text(assistant_content)},
    ]
    canonical_input = f"{task}\n{canonical_json(messages[:-1])}"
    canonical_example = f"{canonical_input}\n{messages[-1]['content']}"
    resolved_group_hash = group_hash or sha256_text(
        f"biolab-public-group-v1:{source_group}"
    )
    return {
        "dataset_schema_version": builder.DATASET_SCHEMA_VERSION,
        "source_schema_version": SOURCE_SCHEMA_VERSION,
        "task_type": task,
        "split": split,
        "provenance": "public_licensed",
        "group_hash": resolved_group_hash,
        "input_hash": sha256_text(f"biolab-public-input-v1:{canonical_input}"),
        "example_hash": sha256_text(
            f"biolab-public-example-v1:{canonical_example}"
        ),
        "messages": messages,
    }


def decision_and_answer(target: str) -> tuple[str, str]:
    match = re.match(
        r"^\s*Decision:\s*(yes|no|maybe)\.\s*(.*)$",
        target,
        flags=re.I | re.S,
    )
    if not match:
        raise AssertionError("PubMed target lacks a yes/no/maybe decision.")
    return match.group(1).lower(), match.group(2).strip()


def analysis_json_target(target: str) -> str:
    decision, answer = decision_and_answer(target)
    summary = f"Decision: {decision}."
    if answer:
        summary += f"\n\n{answer}"
    data = {
        "summary": summary,
        "suggestions": [
            {
                "title": "Replicate the reported comparison",
                "variable_to_change": (
                    "Use an independent sample or repeat run while keeping the "
                    "reported primary outcome unchanged"
                ),
                "rationale": (
                    "An independent replication tests whether the source-supported "
                    f"{decision} conclusion is reproducible."
                ),
                "expected_outcome": (
                    "A result with the same direction would strengthen confidence; "
                    "a different direction would preserve uncertainty."
                ),
                "confidence": "medium",
            },
            {
                "title": "Verify the primary measurement",
                "variable_to_change": (
                    "Repeat or independently verify the source's primary outcome "
                    "measurement"
                ),
                "rationale": (
                    "Measurement confirmation helps separate a robust observation "
                    "from a technical artifact."
                ),
                "expected_outcome": (
                    "Agreement with the reported observation would support the "
                    "conclusion without adding a new numerical claim."
                ),
                "confidence": "medium",
            },
            {
                "title": "Test conclusion robustness",
                "variable_to_change": (
                    "Apply a pre-specified sensitivity analysis or source-appropriate "
                    "control comparison"
                ),
                "rationale": (
                    "A robustness check can reveal whether the conclusion depends on "
                    "one analytical assumption."
                ),
                "expected_outcome": (
                    "A stable decision across the check would increase confidence; "
                    "instability would support a cautious interpretation."
                ),
                "confidence": "low",
            },
        ],
    }
    return canonical_json(data)


def clean_markdown_item(line: str) -> str:
    line = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", line)
    line = re.sub(r"[*_`>#]", "", line)
    line = re.sub(r"\s+", " ", line).strip()
    if re.fullmatch(r"[-|: ]+", line):
        return ""
    return line


def markdown_sections(builder, markdown: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = defaultdict(list)
    current = "preamble"
    for raw_line in markdown.splitlines():
        heading = builder.heading_name(raw_line)
        if heading:
            current = heading.lower()
            continue
        item = clean_markdown_item(raw_line)
        if item:
            sections[current].append(item)
    return sections


def first_section_lines(
    sections: dict[str, list[str]],
    keywords: tuple[str, ...],
    *,
    limit: int,
) -> list[str]:
    values: list[str] = []
    for heading, lines in sections.items():
        if any(keyword in heading for keyword in keywords):
            for line in lines:
                if line not in values:
                    values.append(line)
                if len(values) >= limit:
                    return values
    return values


def protocol_json_target(builder, markdown: str, fallback_path: str) -> str:
    sections = markdown_sections(builder, markdown)
    objective = builder.protocol_goal(markdown)
    materials = first_section_lines(
        sections,
        ("material", "reagent", "equipment", "suppl"),
        limit=16,
    )
    controls = first_section_lines(sections, ("control",), limit=8)
    steps = first_section_lines(
        sections,
        (
            "procedure",
            "method",
            "preparation",
            "collection",
            "measurement",
            "genotyping",
            "quality control",
            "analysis",
        ),
        limit=16,
    )
    plate_lines = first_section_lines(
        sections,
        ("plate layout", "layout"),
        limit=4,
    )
    readout_lines = first_section_lines(
        sections,
        ("expected readout", "readout", "result"),
        limit=4,
    )
    analysis_lines = first_section_lines(
        sections,
        ("data analysis", "analysis", "quantification"),
        limit=4,
    )
    safety_lines = first_section_lines(
        sections,
        ("safety", "warning", "ethical"),
        limit=4,
    )
    review_notes: list[str] = []
    if not controls:
        review_notes.append("No explicit controls are specified in the supplied source.")
    if not plate_lines:
        review_notes.append("No plate or sample layout is specified in the supplied source.")
    if not steps:
        steps = ["No actionable procedural step is specified in the supplied source excerpt."]
        review_notes.append("The supplied excerpt does not contain an actionable procedure.")
    if not materials:
        materials = ["No materials are specified in the supplied source excerpt."]
        review_notes.append("The supplied excerpt does not contain a materials list.")
    review_notes.extend(f"Safety: {line}" for line in safety_lines)
    data = {
        "objective": objective,
        "materials": materials,
        "controls": controls,
        "plate_layout": " ".join(plate_lines)
        if plate_lines
        else "Not specified in the supplied source.",
        "steps": steps,
        "expected_readout": " ".join(readout_lines)
        if readout_lines
        else "Not specified in the supplied source.",
        "suggested_analysis": " ".join(analysis_lines)
        if analysis_lines
        else "Not specified in the supplied source.",
        "review_notes": review_notes,
        "changes_summary": [],
    }
    if not objective or set(data) != PROTOCOL_KEYS:
        raise AssertionError(f"Could not structure protocol {fallback_path}.")
    return canonical_json(data)


def strict_pubmed_prompt(original_user: str, *, structured: bool) -> str:
    if structured:
        contract = """
Return valid JSON only with exactly these fields:
{
  "summary": "a complete source-grounded decision and explanation",
  "suggestions": [
    {
      "title": "...",
      "variable_to_change": "...",
      "rationale": "...",
      "expected_outcome": "...",
      "confidence": "low|medium|high"
    }
  ]
}
The suggestions array must contain exactly three cautious, source-compatible
follow-ups. Do not put markdown fences around the JSON.
"""
    else:
        contract = """
Response contract:
- First line exactly: Decision: yes. or Decision: no. or Decision: maybe.
- Then one concise evidence paragraph.
- Do not add measurements absent from the source, generic preambles, or an
  unfinished list.
"""
    return f"{original_user}\n\n{contract.strip()}"


def strict_protocol_prompt(original_user: str) -> str:
    return (
        f"{original_user}\n\n"
        "Return valid JSON only, without markdown fences, with exactly these keys: "
        "objective, materials, controls, plate_layout, steps, expected_readout, "
        "suggested_analysis, review_notes, changes_summary. Every array must contain "
        "strings only. Use an empty array or state that a field is not specified "
        "instead of inventing a value."
    )


def build_strict_train_variants(
    builder,
    iteration2_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    original_train = [row for row in iteration2_rows if row["split"] == "train"]
    for task, count in STRICT_VARIANT_COUNTS.items():
        candidates = sorted(
            (row for row in original_train if row["task_type"] == task),
            key=lambda row: sha256_text(
                f"biolab-iteration3-strict-variant-v1:{row['example_hash']}"
            ),
        )
        if len(candidates) < count:
            raise AssertionError(f"Not enough train rows for strict task {task}.")
        for original in candidates[:count]:
            old_user = original["messages"][-2]["content"]
            old_target = original["messages"][-1]["content"]
            if task == "experiment_analysis":
                user = strict_pubmed_prompt(old_user, structured=True)
                target = analysis_json_target(old_target)
            elif task in builder.PROTOCOL_TASKS:
                user = strict_protocol_prompt(old_user)
                target = protocol_json_target(
                    builder,
                    old_target,
                    f"strict-variant-{original['example_hash']}",
                )
            else:
                user = strict_pubmed_prompt(old_user, structured=False)
                target = old_target
            variants.append(
                make_row(
                    builder,
                    task=task,
                    split="train",
                    user_content=user,
                    assistant_content=target,
                    group_hash=original["group_hash"],
                )
            )
    if len(variants) != 40:
        raise AssertionError(f"Expected 40 strict train variants, found {len(variants)}.")
    return variants


def build_pubmed_holdouts(
    builder,
    iteration2_builder,
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
                f"biolab-pubmed-iteration3-selection-v1:{row['pubid']}"
            ),
        )
        if len(candidates) < per_decision:
            raise AssertionError(
                f"Not enough unused PubMedQA rows for decision={decision}."
            )
        selected.extend(candidates[:per_decision])
    selected.sort(
        key=lambda row: sha256_text(
            f"biolab-pubmed-iteration3-order-v1:{row['pubid']}"
        )
    )
    if len(selected) != PUBMED_PER_HOLDOUT * 2:
        raise AssertionError("Iteration-3 PubMedQA selection count failed.")

    rows: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    cursor = 0
    for split in ("validation", "test"):
        for task in builder.PUBMED_TASKS:
            for source in selected[cursor : cursor + PUBMED_HOLDOUT_COUNTS[task]]:
                base_user = builder.pubmed_prompt(
                    task,
                    source["question"],
                    source["evidence"],
                )
                base_target = (
                    f"Decision: {source['decision']}.\n\n{source['answer']}"
                )
                structured = task == "experiment_analysis"
                user = strict_pubmed_prompt(base_user, structured=structured)
                target = (
                    analysis_json_target(base_target)
                    if structured
                    else base_target
                )
                row = make_row(
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
                        "source_url": (
                            f"https://pubmed.ncbi.nlm.nih.gov/{source['pubid']}/"
                        ),
                        "source_license": builder.PUBMED_LICENSE,
                        "source_attribution": (
                            "PubMedQA authors and labeled-dataset annotators"
                        ),
                        "response_contract": (
                            "ExperimentAnalysisSchema"
                            if structured
                            else "concise_decision_text"
                        ),
                    }
                )
            cursor += PUBMED_HOLDOUT_COUNTS[task]
    if cursor != len(selected):
        raise AssertionError("Iteration-3 PubMedQA holdout allocation failed.")
    return rows, manifest


def build_protocol_holdouts(
    builder,
    iteration2_builder,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    builder.assert_pinned_revision(
        builder.CADUCEUS_REPO,
        builder.CADUCEUS_REVISION,
    )
    rows: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    for split, task_paths in PROTOCOL_HOLDOUT_PATHS.items():
        for task, path in task_paths.items():
            markdown_row, item = iteration2_builder.protocol_validation_row(
                builder,
                task,
                path,
            )
            user = strict_protocol_prompt(markdown_row["messages"][-2]["content"])
            target = protocol_json_target(
                builder,
                markdown_row["messages"][-1]["content"],
                path,
            )
            row = make_row(
                builder,
                task=task,
                split=split,
                source_group=f"{builder.CADUCEUS_REPO}:{path}",
                user_content=user,
                assistant_content=target,
            )
            item = dict(item)
            item["example_hash"] = row["example_hash"]
            item["split"] = split
            item["response_contract"] = "StructuredProtocolSchema"
            rows.append(row)
            manifest.append(item)
    return rows, manifest


def parse_iteration2_failures(
    review_path: Path | None,
    iteration2_rows: list[dict[str, Any]],
) -> tuple[list[str], dict[str, Any]]:
    if review_path is None:
        available_hashes = {row["example_hash"] for row in iteration2_rows}
        failed_hashes = sorted(AUDITED_ITERATION2_FAILED_HASHES)
        if not set(failed_hashes) <= available_hashes:
            raise AssertionError(
                "The embedded audited failure hashes do not match iteration 2."
            )
        return failed_hashes, dict(AUDITED_ITERATION2_REVIEW_SUMMARY)

    review_bytes = review_path.read_bytes()
    review_sha = sha256_bytes(review_bytes)
    if review_sha != EXPECTED_ITERATION2_REVIEW_SHA256:
        raise AssertionError(
            "Iteration-2 blind review changed: "
            f"expected {EXPECTED_ITERATION2_REVIEW_SHA256}, found {review_sha}."
        )
    test_by_prefix = {
        row["example_hash"][:12]: row
        for row in iteration2_rows
        if row["split"] == "test"
    }
    failures: list[str] = []
    adapter_approvals = 0
    adapter_high_ratings = 0
    adapter_fidelity = 0
    records = list(csv.DictReader(review_path.open(encoding="utf-8", newline="")))
    if len(records) != 20:
        raise AssertionError(f"Expected 20 reviewed examples, found {len(records)}.")
    for record in records:
        prefix = record["evaluation_id"].rsplit("-", 1)[-1]
        if prefix not in test_by_prefix:
            raise AssertionError(f"Unknown review example prefix {prefix}.")
        adapter_candidate = "a" if int(prefix[:8], 16) % 2 == 1 else "b"
        approved = record[f"candidate_{adapter_candidate}_approved"].lower() == "true"
        rating = int(record[f"candidate_{adapter_candidate}_rating"])
        fidelity = (
            record[f"candidate_{adapter_candidate}_measurement_fidelity"].lower()
            == "true"
        )
        adapter_approvals += int(approved)
        adapter_high_ratings += int(rating >= 4)
        adapter_fidelity += int(fidelity)
        if not approved or rating < 4 or not fidelity:
            failures.append(test_by_prefix[prefix]["example_hash"])
    if (adapter_approvals, adapter_high_ratings, adapter_fidelity) != (5, 5, 18):
        raise AssertionError(
            "Blind review does not reproduce the verified iteration-2 adapter metrics."
        )
    return sorted(failures), {
        "review_sha256": review_sha,
        "records": len(records),
        "adapter_approval_count": adapter_approvals,
        "adapter_rating_4_or_5_count": adapter_high_ratings,
        "adapter_measurement_fidelity_count": adapter_fidelity,
        "failed_adapter_examples_promoted_for_correction": len(failures),
    }


def validate_structured_target(task: str, target: str) -> None:
    parsed = json.loads(target)
    if task == "experiment_analysis":
        if set(parsed) != ANALYSIS_KEYS:
            raise AssertionError("Experiment analysis JSON keys changed.")
        suggestions = parsed["suggestions"]
        if not isinstance(parsed["summary"], str) or not parsed["summary"].strip():
            raise AssertionError("Experiment analysis summary is empty.")
        if not isinstance(suggestions, list) or len(suggestions) != 3:
            raise AssertionError("Experiment analysis must have exactly three suggestions.")
        for suggestion in suggestions:
            if set(suggestion) != ANALYSIS_SUGGESTION_KEYS:
                raise AssertionError("Experiment analysis suggestion keys changed.")
            if suggestion["confidence"] not in {"low", "medium", "high"}:
                raise AssertionError("Invalid suggestion confidence.")
            if any(
                not isinstance(suggestion[key], str) or not suggestion[key].strip()
                for key in ANALYSIS_SUGGESTION_KEYS - {"confidence"}
            ):
                raise AssertionError("Empty experiment analysis suggestion field.")
    elif task in {"protocol_generation", "sop_structuring"}:
        if set(parsed) != PROTOCOL_KEYS:
            raise AssertionError("Structured protocol JSON keys changed.")
        for key in (
            "objective",
            "plate_layout",
            "expected_readout",
            "suggested_analysis",
        ):
            if not isinstance(parsed[key], str):
                raise AssertionError(f"Structured protocol {key} must be a string.")
        for key in (
            "materials",
            "controls",
            "steps",
            "review_notes",
            "changes_summary",
        ):
            if not isinstance(parsed[key], list) or not all(
                isinstance(item, str) for item in parsed[key]
            ):
                raise AssertionError(f"Structured protocol {key} must be string[].")
    else:
        raise AssertionError(f"Unexpected structured task {task}.")


def unsupported_numbers(target: str, prompt: str) -> list[str]:
    prompt_numbers = {
        match.group(0).replace(",", "")
        for match in NUMBER_RE.finditer(prompt)
    }
    return sorted(
        {
            match.group(0).replace(",", "")
            for match in NUMBER_RE.finditer(target)
            if match.group(0).replace(",", "") not in prompt_numbers
        }
    )


def validate_iteration(rows: list[dict[str, Any]], builder) -> dict[str, Any]:
    if len(rows) != 300:
        raise AssertionError(f"Expected 300 examples, found {len(rows)}.")
    split_counts = Counter(row["split"] for row in rows)
    if split_counts != Counter({"train": 260, "validation": 20, "test": 20}):
        raise AssertionError(f"Unexpected iteration-3 splits: {dict(split_counts)}")
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
    structured_counts = Counter()
    task_counts = Counter()
    for index, row in enumerate(rows, start=1):
        if set(row) != expected_keys:
            raise AssertionError(f"Row {index} has unexpected keys.")
        if row["dataset_schema_version"] != builder.DATASET_SCHEMA_VERSION:
            raise AssertionError(f"Row {index} has an invalid dataset schema.")
        if row["source_schema_version"] < 1:
            raise AssertionError(f"Row {index} has an invalid source schema.")
        if row["provenance"] != "public_licensed":
            raise AssertionError(f"Row {index} has false provenance.")
        if row["task_type"] not in builder.ALL_TASKS:
            raise AssertionError(f"Row {index} has an invalid task.")
        if row["split"] not in builder.SPLITS:
            raise AssertionError(f"Row {index} has an invalid split.")
        if row["input_hash"] in input_hashes:
            raise AssertionError(f"Duplicate input at row {index}.")
        if row["example_hash"] in example_hashes:
            raise AssertionError(f"Duplicate example at row {index}.")
        input_hashes.add(row["input_hash"])
        example_hashes.add(row["example_hash"])
        group_splits[row["group_hash"]].add(row["split"])
        split_tasks[row["split"]].add(row["task_type"])
        task_counts[row["task_type"]] += 1
        roles = [message.get("role") for message in row["messages"]]
        if roles != ["system", "user", "assistant"]:
            raise AssertionError(f"Row {index} has invalid message roles.")
        joined = "\n".join(message["content"] for message in row["messages"])
        if (
            builder.EMAIL_RE.search(joined)
            or builder.URL_RE.search(joined)
            or builder.FILE_RE.search(joined)
        ):
            raise AssertionError(f"Row {index} failed the privacy scan.")
        target = row["messages"][-1]["content"]
        prompt = "\n".join(message["content"] for message in row["messages"][:-1])
        if target.lstrip().startswith("{"):
            validate_structured_target(row["task_type"], target)
            structured_counts[row["split"]] += 1
            unsupported = unsupported_numbers(target, prompt)
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
                f"{split} lacks task coverage: "
                f"{sorted(required_tasks - split_tasks[split])}"
            )
        if structured_counts[split] != 5:
            raise AssertionError(
                f"{split} needs five structured contract examples, "
                f"found {structured_counts[split]}."
            )
    return {
        "examples": len(rows),
        "split_counts": dict(sorted(split_counts.items())),
        "task_counts": dict(sorted(task_counts.items())),
        "structured_counts": dict(sorted(structured_counts.items())),
        "holdout_task_coverage": {
            split: sorted(split_tasks[split])
            for split in ("validation", "test")
        },
        "provenance": "public_licensed",
    }


def build_iteration(
    builder,
    iteration2_builder,
    iteration2_rows: list[dict[str, Any]],
    iteration2_manifest: dict[str, Any],
    failed_hashes: list[str],
    review_summary: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    promoted_rows = []
    for original in iteration2_rows:
        row = dict(original)
        row["split"] = "train"
        promoted_rows.append(row)

    strict_variants = build_strict_train_variants(builder, iteration2_rows)
    used_pubids = {
        str(item["source_identifier"])
        for item in iteration2_manifest["examples"]
        if item["source_dataset"] == builder.PUBMED_REPO
    }
    pubmed_holdouts, pubmed_manifest = build_pubmed_holdouts(
        builder,
        iteration2_builder,
        used_pubids,
    )
    protocol_holdouts, protocol_manifest = build_protocol_holdouts(
        builder,
        iteration2_builder,
    )
    rows = sorted(
        promoted_rows + strict_variants + pubmed_holdouts + protocol_holdouts,
        key=lambda row: row["example_hash"],
    )
    summary = validate_iteration(rows, builder)

    split_by_hash = {row["example_hash"]: row["split"] for row in rows}
    prior_manifest = []
    for original in iteration2_manifest["examples"]:
        item = dict(original)
        item["split"] = split_by_hash[item["example_hash"]]
        prior_manifest.append(item)
    manifest_by_hash = {
        item["example_hash"]: item
        for item in iteration2_manifest["examples"]
    }
    strict_manifest = []
    for row in strict_variants:
        source_candidates = [
            item
            for item in iteration2_manifest["examples"]
            if item["source_identifier"]
            and item["source_dataset"]
            and any(
                old["group_hash"] == row["group_hash"]
                and old["example_hash"] == item["example_hash"]
                for old in iteration2_rows
            )
        ]
        if not source_candidates:
            # Match by shared group hash through the old row, then its manifest.
            old = next(
                old
                for old in iteration2_rows
                if old["group_hash"] == row["group_hash"]
                and old["split"] == "train"
            )
            source_item = manifest_by_hash[old["example_hash"]]
        else:
            source_item = source_candidates[0]
        strict_manifest.append(
            {
                **source_item,
                "example_hash": row["example_hash"],
                "split": "train",
                "response_contract": (
                    "ExperimentAnalysisSchema"
                    if row["task_type"] == "experiment_analysis"
                    else "StructuredProtocolSchema"
                    if row["task_type"] in builder.PROTOCOL_TASKS
                    else "concise_decision_text"
                ),
                "training_role": "strict_contract_replay",
            }
        )
    manifest_examples = sorted(
        prior_manifest + strict_manifest + pubmed_manifest + protocol_manifest,
        key=lambda item: item["example_hash"],
    )
    return rows, {
        "iteration_schema_version": ITERATION_SCHEMA_VERSION,
        "dataset_schema_version": builder.DATASET_SCHEMA_VERSION,
        "parent_dataset_sha256": EXPECTED_ITERATION2_DATASET_SHA256,
        "parent_review_sha256": EXPECTED_ITERATION2_REVIEW_SHA256,
        "reason": (
            "Iteration 2 improved adapter approval but failed measurement, structured "
            "coverage, and quality gates. Every prior holdout is now training-only; "
            "fresh independent source groups populate validation and test."
        ),
        "target_provenance": (
            "No model output is a label; targets are expert PubMedQA answers, "
            "deterministic website-schema transformations, or grounded Caduceus "
            "protocol excerpts."
        ),
        "failed_adapter_example_hashes": failed_hashes,
        "review_summary": review_summary,
        "summary": summary,
        "sources": iteration2_manifest["sources"],
        "examples": manifest_examples,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--builder", type=Path, required=True)
    parser.add_argument("--iteration2-builder", type=Path, required=True)
    parser.add_argument("--iteration2-jsonl", type=Path, required=True)
    parser.add_argument("--iteration2-manifest", type=Path, required=True)
    parser.add_argument(
        "--iteration2-review",
        type=Path,
        help=(
            "Optional private blind-review CSV. When omitted, the builder uses "
            "the audited anonymous failure hashes embedded above."
        ),
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    builder = load_module("biolab_public_builder", args.builder)
    iteration2_builder = load_module(
        "biolab_iteration2_builder",
        args.iteration2_builder,
    )
    iteration2_rows, iteration2_bytes = load_jsonl(args.iteration2_jsonl)
    actual_sha = sha256_bytes(iteration2_bytes)
    if actual_sha != EXPECTED_ITERATION2_DATASET_SHA256:
        raise AssertionError(
            "Iteration-2 dataset changed: "
            f"expected {EXPECTED_ITERATION2_DATASET_SHA256}, found {actual_sha}."
        )
    iteration2_manifest = json.loads(
        args.iteration2_manifest.read_text(encoding="utf-8")
    )
    if iteration2_manifest["dataset_sha256"] != actual_sha:
        raise AssertionError("Iteration-2 manifest does not match its JSONL.")
    failed_hashes, review_summary = parse_iteration2_failures(
        args.iteration2_review,
        iteration2_rows,
    )
    rows, manifest = build_iteration(
        builder,
        iteration2_builder,
        iteration2_rows,
        iteration2_manifest,
        failed_hashes,
        review_summary,
    )
    data = (
        "\n".join(canonical_json(row) for row in rows) + "\n"
    ).encode("utf-8")
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
