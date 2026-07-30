#!/usr/bin/env python3
"""Build a reproducible, public-licensed Bio-Lab bootstrap dataset.

This script deliberately uses only the Python standard library. It downloads:

* 180 expert-annotated rows from PubMedQA's labeled split (MIT); and
* 20 hand-processed protocol markdown files from Caduceus (CC BY 4.0).

It never calls an LLM. The resulting targets are source-dataset answers or
source-dataset protocol text, not ChatGPT/Gemini-generated labels.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


DATASET_SCHEMA_VERSION = 2
BOOTSTRAP_SCHEMA_VERSION = 1
TOTAL_EXAMPLES = 200
PUBMED_EXAMPLES = 180
PROTOCOL_EXAMPLES = 20
MAX_SOURCE_CHARS = 6_500

PUBMED_REPO = "qiaojin/PubMedQA"
PUBMED_REVISION = "9001f2853fb87cab8d220904e0de81ac6973b318"
PUBMED_LICENSE = "MIT"
PUBMED_DATASET_URL = f"https://huggingface.co/datasets/{PUBMED_REPO}"

CADUCEUS_REPO = "Kquant03/Caduceus-Dataset"
CADUCEUS_REVISION = "210c578a82a18455fe337d6c3261759eaa7c7d53"
CADUCEUS_LICENSE = "CC-BY-4.0"
CADUCEUS_DATASET_URL = f"https://huggingface.co/datasets/{CADUCEUS_REPO}"

PUBMED_TASKS = (
    "experiment_analysis",
    "data_analysis",
    "experiment_chat",
    "experiment_comparison",
    "project_chat",
    "project_synthesis",
    "general_chat",
)
PROTOCOL_TASKS = ("protocol_generation", "sop_structuring")
ALL_TASKS = PUBMED_TASKS + PROTOCOL_TASKS
SPLITS = ("train", "validation", "test")

# Explicitly limited to low-risk educational, analytical, and routine BSL-1
# protocols. Path selection is reviewed and pinned instead of accepting new
# upstream files automatically.
PROTOCOL_PATHS = (
    "markdown-output/0-1m-edta-0-2m-mgcl2-0-2m-ascorbate-buffer-c2yyfv.md",
    "markdown-output/2-agarose-gel-cac7sazn.md",
    "markdown-output/adding-solid-fertilisers-to-soil-in-pot-experiment-4engtde.md",
    "markdown-output/application-of-phyto-pam-ii-compact-version-for-ru-cjgtujwn.md",
    "markdown-output/assessing-coastal-risk-and-the-economics-of-climat-miyc4fw.md",
    "markdown-output/ctab-chloroform-isoamyl-alcohol-dna-extraction-pro-cxhexj3e.md",
    "markdown-output/cyanobacteria-total-lipid-extraction-ibkcakw.md",
    "markdown-output/dissolved-sulfide-concentrations-h2s-hs-s2-colorim-bd7ji9kn.md",
    "markdown-output/enzyme-ligand-interaction-monitored-by-synchrotron-bnxfmfjn.md",
    "markdown-output/functionality-test-openvent-polymerase-pcr-master-cca4ssgw.md",
    "markdown-output/gene-regulatory-network-bm6rk9d6.md",
    "markdown-output/genetic-diversity-and-population-structure-of-dome-umkeu4w.md",
    "markdown-output/low-volume-titrations-for-ligand-binding-monitored-bnximfke.md",
    "markdown-output/microtiter-plate-microbial-growth-measurements-dcex2tfn.md",
    "markdown-output/modelling-protocols-for-derivation-of-fe-iii-nica-brc4m2yw.md",
    "markdown-output/modified-salting-out-method-for-high-molecular-wei-c2igycbw.md",
    "markdown-output/nonlinear-spectral-mixture-effects-for-photosynthe-ia5cag6.md",
    "markdown-output/preparation-of-ink-for-electrode-deposition-via-pa-btm3nk8n.md",
    "markdown-output/sparc-analysis-of-multiplexed-bead-data-using-mple-bakhict6.md",
    "markdown-output/useful-methods-4-stock-cultivation-of-duckweed-b56qq9dw.md",
)

EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
URL_RE = re.compile(r"https?://\S+")
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\(https?://[^)]+\)")
FILE_RE = re.compile(r"\b[^\s/\\]{1,120}\.(?:csv|tsv|txt|xlsx|xls|docx|pdf)\b", re.I)
METADATA_LINE_RE = re.compile(
    r"^\s*\*\*(?:Author|Authors|Affiliation|Date|Date of Protocol|Protocol Shared via):\*\*.*$",
    re.I | re.M,
)
CODE_FENCE_RE = re.compile(r"^\s*```(?:markdown)?\s*$", re.I | re.M)
CONTENT_SECTION_NAMES = {
    "abstract",
    "background",
    "guidelines",
    "introduction",
    "materials",
    "materials and methods",
    "method",
    "methods",
    "procedure",
    "procedures",
    "protocol",
    "reagents",
    "safety",
    "steps",
    "supplies",
    "equipment",
}
TRAILING_ATTRIBUTION_SECTIONS = {
    "acknowledgement",
    "acknowledgements",
    "acknowledgment",
    "acknowledgments",
    "citation",
    "citations",
    "references",
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def request_bytes(url: str, attempts: int = 3) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "BioLab-public-bootstrap/1.0"},
    )
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
    raise RuntimeError(f"Could not download {url}") from last_error


def request_json(url: str) -> Any:
    return json.loads(request_bytes(url).decode("utf-8"))


def assert_pinned_revision(repo: str, expected: str) -> None:
    metadata = request_json(f"https://huggingface.co/api/datasets/{repo}")
    actual = metadata.get("sha")
    if actual != expected:
        raise AssertionError(
            f"{repo} changed upstream: expected {expected}, found {actual}. "
            "Review the new revision and update the pin deliberately."
        )
    if metadata.get("private") or metadata.get("gated"):
        raise AssertionError(f"{repo} is no longer an ungated public dataset.")


def clean_text(value: str) -> str:
    value = value.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    value = EMAIL_RE.sub("[redacted-email]", value)
    value = MARKDOWN_LINK_RE.sub(r"\1", value)
    value = URL_RE.sub("[removed-url]", value)
    value = FILE_RE.sub("[redacted-file]", value)
    value = re.sub(r"[ \t]+\n", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def clean_protocol_markdown(value: str) -> str:
    value = CODE_FENCE_RE.sub("", value)
    value = METADATA_LINE_RE.sub("", value)
    value = re.sub(r"^\s*\*\*End of Output\*\*\s*$", "", value, flags=re.I | re.M)
    return clean_text(value)


def protocol_public_attribution(value: str) -> str:
    """Retain the public author/source preamble in the separate audit manifest."""

    value = CODE_FENCE_RE.sub("", value)
    value = re.sub(r"^\s*\*\*End of Output\*\*\s*$", "", value, flags=re.I | re.M)
    lines = value.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    preamble_end = len(lines)
    for index, line in enumerate(lines):
        heading = heading_name(line)
        if heading and heading.lower() in CONTENT_SECTION_NAMES:
            preamble_end = index
            break
    excerpt = "\n".join(lines[:preamble_end])
    excerpt = re.sub(r"\n{3,}", "\n\n", excerpt).strip()
    return excerpt[:2_500]


def heading_name(line: str) -> str | None:
    match = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
    return match.group(1).strip().rstrip(":") if match else None


def deidentify_protocol_preamble(markdown: str, fallback_path: str) -> str:
    """Remove author/institution/date blocks while retaining scientific content."""

    title = protocol_title(markdown, fallback_path)
    goal = protocol_goal(markdown)
    lines = markdown.splitlines()
    body_start: int | None = None
    body_end = len(lines)
    for index, line in enumerate(lines):
        heading = heading_name(line)
        if not heading:
            continue
        normalized = heading.lower()
        if body_start is None and normalized in CONTENT_SECTION_NAMES:
            body_start = index
        if body_start is not None and normalized in TRAILING_ATTRIBUTION_SECTIONS:
            body_end = index
            break
    if body_start is None:
        raise AssertionError(f"Protocol {fallback_path} lacks a recognized scientific section.")
    body = "\n".join(lines[body_start:body_end])
    body = re.sub(r"^.*(?:doi\.org|protocols\.io).*$", "", body, flags=re.I | re.M)
    reconstructed = f"# {title}\n\n## Goal/Experiment\n{goal}\n\n{body}"
    return clean_text(reconstructed)


def protocol_title(markdown: str, fallback_path: str) -> str:
    for line in markdown.splitlines():
        match = re.match(r"^#{1,3}\s+(.+?)\s*$", line)
        if match:
            heading = match.group(1).strip().rstrip(":")
            if heading.lower() not in {"goal/experiment", "goal"}:
                return heading
    stem = Path(fallback_path).stem
    return re.sub(r"-[a-z0-9]{8}$", "", stem).replace("-", " ").title()


def protocol_goal(markdown: str) -> str:
    lines = markdown.splitlines()
    for index, line in enumerate(lines):
        if re.match(r"^#{1,3}\s+Goal(?:/Experiment)?\s*:?\s*$", line, re.I):
            collected: list[str] = []
            for candidate in lines[index + 1 :]:
                if candidate.startswith("#"):
                    break
                if candidate.strip():
                    collected.append(candidate.strip())
            if collected:
                return clean_text(" ".join(collected))[:900]
    return "Follow the supplied source-derived procedure without inventing measurements."


def protocol_section_names(markdown: str) -> list[str]:
    names: list[str] = []
    for line in markdown.splitlines():
        match = re.match(r"^#{2,4}\s+(.+?)\s*$", line)
        if match:
            name = match.group(1).strip().rstrip(":")
            if name.lower() not in {"goal/experiment", "goal"} and name not in names:
                names.append(name)
    return names[:12]


def protocol_plain_notes(markdown: str) -> str:
    plain = re.sub(r"^#{1,6}\s*", "", markdown, flags=re.M)
    plain = re.sub(r"^\s*[-*]\s+", "", plain, flags=re.M)
    plain = re.sub(r"^\s*\d+\.\s+", "", plain, flags=re.M)
    plain = re.sub(r"[*_>`]", "", plain)
    return clean_text(plain)[:1_500]


def system_message(task: str) -> str:
    return (
        f"<TASK={task}>\n"
        "Use only the supplied open-licensed scientific source. "
        "Do not invent measurements or claim clinical certainty. "
        "Preserve uncertainty and distinguish reported evidence from inference."
    )


def pubmed_prompt(task: str, question: str, evidence: str) -> str:
    instructions = {
        "experiment_analysis": (
            "Analyze this published experiment record. Answer its research question and state "
            "whether the supplied evidence supports yes, no, or maybe."
        ),
        "data_analysis": (
            "Interpret the reported data narrative. Answer the research question while separating "
            "reported observations from inference."
        ),
        "experiment_chat": (
            "Answer the experiment question using only the supplied record."
        ),
        "experiment_comparison": (
            "Compare the study objective with its reported observations, then answer the research "
            "question without adding unsupported claims."
        ),
        "project_chat": (
            "Answer this project-level scientific question from the supplied published evidence."
        ),
        "project_synthesis": (
            "Synthesize the supplied study evidence into a concise project conclusion and decision."
        ),
        "general_chat": (
            "Answer the biomedical question from the supplied published evidence. This is not "
            "medical advice."
        ),
    }
    return clean_text(
        f"{instructions[task]}\n\nResearch question:\n{question}\n\nPublished evidence:\n{evidence}"
    )


def public_row(
    *,
    task: str,
    split: str,
    source_group: str,
    user_content: str,
    assistant_content: str,
) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": system_message(task)},
        {"role": "user", "content": clean_text(user_content)},
        {"role": "assistant", "content": clean_text(assistant_content)},
    ]
    input_messages = messages[:-1]
    canonical_input = f"{task}\n{canonical_json(input_messages)}"
    canonical_example = f"{canonical_input}\n{messages[-1]['content']}"
    return {
        "dataset_schema_version": DATASET_SCHEMA_VERSION,
        "source_schema_version": BOOTSTRAP_SCHEMA_VERSION,
        "task_type": task,
        "split": split,
        "provenance": "public_licensed",
        "group_hash": sha256_text(f"biolab-public-group-v1:{source_group}"),
        "input_hash": sha256_text(f"biolab-public-input-v1:{canonical_input}"),
        "example_hash": sha256_text(f"biolab-public-example-v1:{canonical_example}"),
        "messages": messages,
    }


def assigned_split(position: int, count: int, holdout_per_split: int) -> str:
    if position < holdout_per_split:
        return "validation"
    if position < holdout_per_split * 2:
        return "test"
    if count - holdout_per_split * 2 <= 0:
        raise AssertionError("Every task needs training examples after holdout assignment.")
    return "train"


def fetch_pubmed_rows() -> list[dict[str, Any]]:
    assert_pinned_revision(PUBMED_REPO, PUBMED_REVISION)
    collected: list[dict[str, Any]] = []
    base = "https://datasets-server.huggingface.co/rows"
    for offset in range(0, 1_000, 100):
        query = urllib.parse.urlencode(
            {
                "dataset": PUBMED_REPO,
                "config": "pqa_labeled",
                "split": "train",
                "offset": offset,
                "length": 100,
            }
        )
        payload = request_json(f"{base}?{query}")
        collected.extend(item["row"] for item in payload.get("rows", []))
    if len(collected) != 1_000:
        raise AssertionError(f"Expected 1,000 labeled PubMedQA rows, found {len(collected)}.")
    return collected


def select_pubmed_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        decision = str(row.get("final_decision", "")).strip().lower()
        question = clean_text(str(row.get("question", "")))
        answer = clean_text(str(row.get("long_answer", "")))
        context = row.get("context") or {}
        contexts = context.get("contexts") if isinstance(context, dict) else None
        if decision not in {"yes", "no", "maybe"}:
            continue
        if not question or not answer or not isinstance(contexts, list):
            continue
        evidence = clean_text("\n".join(str(item) for item in contexts if str(item).strip()))
        if not evidence:
            continue
        if len(question) + len(answer) + len(evidence) > MAX_SOURCE_CHARS:
            continue
        normalized = {
            "pubid": str(row["pubid"]),
            "question": question,
            "answer": answer,
            "evidence": evidence,
            "decision": decision,
        }
        buckets[decision].append(normalized)

    selected: list[dict[str, Any]] = []
    for decision in ("yes", "no", "maybe"):
        candidates = sorted(
            buckets[decision],
            key=lambda row: sha256_text(f"biolab-pubmed-selection-v1:{row['pubid']}"),
        )
        if len(candidates) < PUBMED_EXAMPLES // 3:
            raise AssertionError(f"Not enough eligible PubMedQA rows for decision={decision}.")
        selected.extend(candidates[: PUBMED_EXAMPLES // 3])
    return sorted(
        selected,
        key=lambda row: sha256_text(f"biolab-pubmed-order-v1:{row['pubid']}"),
    )


def allocate_pubmed_tasks(rows: list[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    counts = {
        task: PUBMED_EXAMPLES // len(PUBMED_TASKS)
        + (1 if index < PUBMED_EXAMPLES % len(PUBMED_TASKS) else 0)
        for index, task in enumerate(PUBMED_TASKS)
    }
    allocated: list[tuple[str, list[dict[str, Any]]]] = []
    cursor = 0
    for task in PUBMED_TASKS:
        count = counts[task]
        allocated.append((task, rows[cursor : cursor + count]))
        cursor += count
    if cursor != PUBMED_EXAMPLES:
        raise AssertionError("PubMedQA task allocation did not consume exactly 180 rows.")
    return allocated


def build_pubmed_examples() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected = select_pubmed_rows(fetch_pubmed_rows())
    examples: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    for task, task_rows in allocate_pubmed_tasks(selected):
        for position, source in enumerate(task_rows):
            split = assigned_split(position, len(task_rows), holdout_per_split=2)
            row = public_row(
                task=task,
                split=split,
                source_group=f"{PUBMED_REPO}:{source['pubid']}",
                user_content=pubmed_prompt(task, source["question"], source["evidence"]),
                assistant_content=(
                    f"Decision: {source['decision']}.\n\n{source['answer']}"
                ),
            )
            examples.append(row)
            manifest.append(
                {
                    "example_hash": row["example_hash"],
                    "task_type": task,
                    "split": split,
                    "source_dataset": PUBMED_REPO,
                    "source_revision": PUBMED_REVISION,
                    "source_identifier": source["pubid"],
                    "source_url": (
                        f"https://pubmed.ncbi.nlm.nih.gov/{source['pubid']}/"
                    ),
                    "source_license": PUBMED_LICENSE,
                    "source_attribution": "PubMedQA authors and labeled-dataset annotators",
                }
            )
    return examples, manifest


def download_protocol(path: str) -> str:
    encoded_path = urllib.parse.quote(path, safe="/")
    url = (
        f"https://huggingface.co/datasets/{CADUCEUS_REPO}/resolve/"
        f"{CADUCEUS_REVISION}/{encoded_path}"
    )
    return request_bytes(url).decode("utf-8")


def build_protocol_examples() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    assert_pinned_revision(CADUCEUS_REPO, CADUCEUS_REVISION)
    examples: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []
    per_task = PROTOCOL_EXAMPLES // len(PROTOCOL_TASKS)
    for task_index, task in enumerate(PROTOCOL_TASKS):
        paths = PROTOCOL_PATHS[task_index * per_task : (task_index + 1) * per_task]
        for position, path in enumerate(paths):
            raw_protocol = download_protocol(path)
            public_attribution = protocol_public_attribution(raw_protocol)
            markdown = clean_protocol_markdown(raw_protocol)
            markdown = deidentify_protocol_preamble(markdown, path)
            if not markdown or len(markdown) > 5_500:
                raise AssertionError(
                    f"Protocol {path} is empty or too long after sanitization ({len(markdown)} chars)."
                )
            title = protocol_title(markdown, path)
            goal = protocol_goal(markdown)
            sections = protocol_section_names(markdown)
            if task == "protocol_generation":
                user_content = (
                    "Create a structured protocol using only these source-derived requirements. "
                    "Retain supplied quantities and safety notes; do not invent missing values.\n\n"
                    f"Title: {title}\nGoal: {goal}\n"
                    f"Required sections: {', '.join(sections) or 'Goal, materials, procedure, safety'}"
                )
            else:
                user_content = (
                    "Convert these source-derived unstructured notes into a clear SOP. Preserve "
                    "the supplied scientific values and safety language.\n\n"
                    f"Procedure title: {title}\nSource notes:\n{protocol_plain_notes(markdown)}"
                )
            split = assigned_split(position, len(paths), holdout_per_split=3)
            row = public_row(
                task=task,
                split=split,
                source_group=f"{CADUCEUS_REPO}:{path}",
                user_content=user_content,
                assistant_content=markdown,
            )
            examples.append(row)
            manifest.append(
                {
                    "example_hash": row["example_hash"],
                    "task_type": task,
                    "split": split,
                    "source_dataset": CADUCEUS_REPO,
                    "source_revision": CADUCEUS_REVISION,
                    "source_identifier": path,
                    "source_url": (
                        f"https://huggingface.co/datasets/{CADUCEUS_REPO}/blob/"
                        f"{CADUCEUS_REVISION}/{urllib.parse.quote(path, safe='/')}"
                    ),
                    "source_license": CADUCEUS_LICENSE,
                    "source_attribution": (
                        "Caduceus Project Dataset contributors and the original protocols.io "
                        "protocol authors; metadata is retained in this manifest rather than "
                        "the de-identified training text."
                    ),
                    "public_attribution_excerpt": public_attribution,
                }
            )
    return examples, manifest


def validate_dataset(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if len(rows) != TOTAL_EXAMPLES:
        raise AssertionError(f"Expected exactly {TOTAL_EXAMPLES} examples, found {len(rows)}.")
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
    task_counts = Counter()
    split_counts = Counter()
    holdout_tasks: dict[str, Counter[str]] = {
        "validation": Counter(),
        "test": Counter(),
    }
    group_splits: dict[str, set[str]] = defaultdict(set)
    input_hashes: set[str] = set()
    example_hashes: set[str] = set()
    decision_counts = Counter()
    for index, row in enumerate(rows, start=1):
        if set(row) != expected_keys:
            raise AssertionError(f"Row {index} has unexpected keys.")
        if row["dataset_schema_version"] != DATASET_SCHEMA_VERSION:
            raise AssertionError(f"Row {index} has an invalid dataset schema.")
        if row["source_schema_version"] != BOOTSTRAP_SCHEMA_VERSION:
            raise AssertionError(f"Row {index} has an invalid bootstrap schema.")
        if row["provenance"] != "public_licensed":
            raise AssertionError(f"Row {index} has false provenance.")
        if row["task_type"] not in ALL_TASKS or row["split"] not in SPLITS:
            raise AssertionError(f"Row {index} has an invalid task or split.")
        if not all(
            isinstance(row[key], str) and re.fullmatch(r"[a-f0-9]{64}", row[key])
            for key in ("group_hash", "input_hash", "example_hash")
        ):
            raise AssertionError(f"Row {index} has an invalid hash.")
        messages = row["messages"]
        if [message.get("role") for message in messages] != ["system", "user", "assistant"]:
            raise AssertionError(f"Row {index} has invalid message roles.")
        if any(not clean_text(str(message.get("content", ""))) for message in messages):
            raise AssertionError(f"Row {index} has an empty message.")
        joined = "\n".join(message["content"] for message in messages)
        if EMAIL_RE.search(joined) or URL_RE.search(joined) or FILE_RE.search(joined):
            raise AssertionError(f"Row {index} failed the privacy scan.")
        if row["input_hash"] in input_hashes or row["example_hash"] in example_hashes:
            raise AssertionError(f"Row {index} is duplicated.")
        input_hashes.add(row["input_hash"])
        example_hashes.add(row["example_hash"])
        task_counts[row["task_type"]] += 1
        split_counts[row["split"]] += 1
        group_splits[row["group_hash"]].add(row["split"])
        if row["split"] in holdout_tasks:
            holdout_tasks[row["split"]][row["task_type"]] += 1
        decision_match = re.match(r"Decision:\s+(yes|no|maybe)\.", messages[-1]["content"])
        if decision_match:
            decision_counts[decision_match.group(1)] += 1

    if split_counts != Counter({"train": 160, "validation": 20, "test": 20}):
        raise AssertionError(f"Expected an exact 80/10/10 split, found {dict(split_counts)}.")
    if any(task_counts[task] < 10 for task in ALL_TASKS):
        raise AssertionError(f"Every task needs at least 10 examples: {dict(task_counts)}.")
    for split in ("validation", "test"):
        missing = [task for task in ALL_TASKS if holdout_tasks[split][task] == 0]
        if missing:
            raise AssertionError(f"{split} lacks task coverage: {missing}.")
    if any(len(splits) != 1 for splits in group_splits.values()):
        raise AssertionError("A public source group leaked across splits.")
    if decision_counts != Counter({"yes": 60, "no": 60, "maybe": 60}):
        raise AssertionError(
            f"PubMedQA decision classes are not balanced: {dict(decision_counts)}."
        )
    return {
        "examples": len(rows),
        "task_counts": dict(sorted(task_counts.items())),
        "split_counts": dict(sorted(split_counts.items())),
        "holdout_task_coverage": {
            split: dict(sorted(counts.items()))
            for split, counts in holdout_tasks.items()
        },
        "decision_counts": dict(sorted(decision_counts.items())),
        "provenance": "public_licensed",
    }


def build_dataset() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    pubmed_rows, pubmed_manifest = build_pubmed_examples()
    protocol_rows, protocol_manifest = build_protocol_examples()
    rows = sorted(pubmed_rows + protocol_rows, key=lambda row: row["example_hash"])
    summary = validate_dataset(rows)
    lines = [canonical_json(row) for row in rows]
    dataset_bytes = ("\n".join(lines) + "\n").encode("utf-8")
    manifest = {
        "bootstrap_schema_version": BOOTSTRAP_SCHEMA_VERSION,
        "dataset_schema_version": DATASET_SCHEMA_VERSION,
        "dataset_sha256": hashlib.sha256(dataset_bytes).hexdigest(),
        "summary": summary,
        "sources": [
            {
                "dataset": PUBMED_REPO,
                "revision": PUBMED_REVISION,
                "url": PUBMED_DATASET_URL,
                "license": PUBMED_LICENSE,
                "selection": "180 balanced expert-annotated rows from pqa_labeled",
            },
            {
                "dataset": CADUCEUS_REPO,
                "revision": CADUCEUS_REVISION,
                "url": CADUCEUS_DATASET_URL,
                "license": CADUCEUS_LICENSE,
                "selection": "20 explicitly allowlisted low-risk protocol markdown files",
            },
        ],
        "examples": sorted(
            pubmed_manifest + protocol_manifest,
            key=lambda item: item["example_hash"],
        ),
    }
    return rows, manifest


def self_test() -> None:
    sample_protocol = """
```markdown
# Harmless Test Buffer
# Goal/Experiment:
Prepare a harmless test buffer.
**Author:** Example Person
**Affiliation:** Example Lab
**Protocol Shared via:** [protocols.io link](https://protocols.io/example)
## Reagents
- Water
## Procedure
1. Mix the supplied components.
**End of Output**
```
"""
    cleaned = clean_protocol_markdown(sample_protocol)
    cleaned = deidentify_protocol_preamble(cleaned, "fallback.md")
    assert "Example Person" not in cleaned
    assert "https://" not in cleaned
    assert protocol_title(cleaned, "fallback.md") == "Harmless Test Buffer"
    row = public_row(
        task="protocol_generation",
        split="train",
        source_group="fixture",
        user_content="Create the supplied harmless buffer protocol.",
        assistant_content=cleaned,
    )
    assert row["provenance"] == "public_licensed"
    assert row["messages"][-1]["role"] == "assistant"
    assert len(row["example_hash"]) == 64
    assert assigned_split(0, 10, 3) == "validation"
    assert assigned_split(3, 10, 3) == "test"
    assert assigned_split(6, 10, 3) == "train"
    print("Public bootstrap generator self-test passed.")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("biolab-public-bootstrap.jsonl"),
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("biolab-public-bootstrap-manifest.json"),
    )
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.self_test:
        self_test()
        return 0
    rows, manifest = build_dataset()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    dataset_text = "\n".join(canonical_json(row) for row in rows) + "\n"
    args.output.write_text(dataset_text, encoding="utf-8")
    args.manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "dataset": str(args.output),
                "manifest": str(args.manifest),
                "dataset_sha256": manifest["dataset_sha256"],
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
