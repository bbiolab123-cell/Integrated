#!/usr/bin/env python3
"""Static integrity check for the Colab training notebook.

This deliberately uses only the Python standard library, so it can run in CI
without installing ML packages or downloading model weights.
"""

from __future__ import annotations

import ast
import hashlib
import json
import pathlib
import re
import sys


NOTEBOOK = pathlib.Path(__file__).with_name("biolab_lora_colab.ipynb")
PINNED_LOCAL_SCRIPTS = (
    "build_public_bootstrap_dataset.py",
    "build_public_bootstrap_iteration2.py",
    "build_public_bootstrap_iteration3.py",
    "build_public_bootstrap_iteration4.py",
)
REQUIRED_SNIPPETS = {
    "mistralai/Mistral-7B-Instruct-v0.2",
    "63a8b081895390a26e140280378bc85ec8bce07a",
    "transformers==4.57.6",
    "trl==1.8.0",
    "peft==0.19.1",
    "bitsandbytes==0.49.2",
    "completion_only_loss=True",
    "bnb_4bit_quant_type='nf4'",
    "target_modules=['q_proj', 'v_proj']",
    "TRAINING_DATA_MODE = 'public_bootstrap'",
    "public_licensed",
    "build_public_bootstrap_dataset.py",
    "build_public_bootstrap_iteration3.py",
    "build_public_bootstrap_iteration4.py",
    "PUBLIC_BOOTSTRAP_SCRIPT_SHA256",
    "3c0e71705c443265b3672666ff96c49a2d5cfa616d03b59406af80fdb3c54dcf",
    "423530e9aefdd14361b265f1ba0b86faf1baf7315385026f4f86e9fce82a37b7",
    "Counter({'train': 340, 'validation': 20, 'test': 20})",
    "iteration4_targeted_contract_replay",
    "failed_adapter_example_hashes",
    "IN_KAGGLE",
    "pathlib.Path('/var/colab/hostname').is_file()",
    "torch.cuda.get_device_capability(0)[0] >= 8",
    "checkpoint_steps = min(5, steps_per_epoch)",
    "checkpoints-fp16-restart-safe-v2",
    "eval_strategy='no'",
    "public-bootstrap-source-manifest.json",
    "dataset_sha256",
    "privacy_findings",
    "overlong_count",
    "blind-key.json",
    "release-gate-report.json",
    "RELEASE_GATES_PASSED",
    "adapter_model.safetensors",
}
FORBIDDEN_SECRET_PATTERNS = {
    "Hugging Face token": re.compile(r"\bhf_[A-Za-z0-9]{20,}\b"),
    "OpenAI-style token": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "Cloudflare bearer token": re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._-]{20,}\b"),
}


def fail(message: str) -> None:
    raise AssertionError(message)


def main() -> int:
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    if notebook.get("nbformat") != 4:
        fail("Notebook must use nbformat 4.")
    cells = notebook.get("cells")
    if not isinstance(cells, list) or not cells:
        fail("Notebook has no cells.")

    source = "\n".join(
        "".join(cell.get("source", []))
        for cell in cells
        if cell.get("cell_type") in {"code", "markdown"}
    )
    missing = sorted(snippet for snippet in REQUIRED_SNIPPETS if snippet not in source)
    if missing:
        fail(f"Notebook lost required training gates: {missing}")
    if "TO_BE_REPLACED" in source:
        fail("Notebook contains an unresolved integrity placeholder.")

    for name in PINNED_LOCAL_SCRIPTS:
        script_path = NOTEBOOK.with_name(name)
        script_sha256 = hashlib.sha256(script_path.read_bytes()).hexdigest()
        if script_sha256 not in source:
            fail(f"Notebook does not pin the current {name} hash: {script_sha256}")

    for label, pattern in FORBIDDEN_SECRET_PATTERNS.items():
        if pattern.search(source):
            fail(f"Notebook appears to contain a {label}.")

    for index, cell in enumerate(cells):
        if cell.get("cell_type") != "code":
            continue
        if cell.get("execution_count") is not None:
            fail(f"Code cell {index} contains a saved execution count.")
        if cell.get("outputs"):
            fail(f"Code cell {index} contains saved output.")

        python_lines = [
            line
            for line in "".join(cell.get("source", [])).splitlines()
            if not line.lstrip().startswith(("!", "%"))
        ]
        python_source = "\n".join(python_lines)
        try:
            ast.parse(python_source, filename=f"{NOTEBOOK.name}:cell-{index}")
        except SyntaxError as exc:
            fail(f"Code cell {index} is not valid Python after removing Colab magics: {exc}")

    print(f"Validated {NOTEBOOK.name}: {len(cells)} clean cells and all required gates present.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, json.JSONDecodeError) as error:
        print(f"Training notebook validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
