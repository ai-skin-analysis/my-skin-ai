# SCIN research-data import

`import_scin_metadata.py` is a conservative metadata audit for the official
Google Skin Condition Image Network (SCIN) dataset. It does not download
images, write to class folders, train a model, or activate an output.

## What it preserves

- SCIN `case_id`, which is the contribution boundary. All images from one case
  must remain in one split.
- Original weighted differential labels and the selected primary source label.
- Label weight, mapping kind, source hashes and attribution requirements.

## Run the audit

Place the two official CSV metadata files in `dataset/source_data/scin/`:

```text
scin_cases.csv
scin_labels.csv
```

Then run:

```powershell
.\.venv\Scripts\python.exe import_scin_metadata.py
```

This produces only:

```text
dataset/multiclass/scin_metadata_audit/
  scin_research_candidate_manifest.csv
  scin_metadata_coverage.report.json
```

## Download selected source images

After reading and accepting the SCIN Data Use License, the candidate image paths
can be downloaded without placing them in a training folder:

```powershell
.\.venv\Scripts\python.exe download_scin_candidates.py --accept-scin-license
```

Images are written per SCIN contribution under
`dataset/source_data/scin/images/<case_id>/`. The companion JSONL ledger stores
the source path, selected target, original primary label, local file hash and
outcome. The downloader retries transient network failures; use fewer workers
when a network or DNS service is rate-limiting requests. This download is
deliberately separate from model training.

## Selection rules

A candidate has to be marked image-gradable in SCIN, have an image path, and
have one unique highest-weight source label at or above the configured threshold.
Only explicit source-label mappings in `scin_source_label_policy.json` are
eligible. Broad labels (for example `Tinea`) and combined labels (for example
`Morphea/Scleroderma`) are intentionally not turned into one of the project's
50 targets.

`Photodermatitis` is reported as source coverage but is not selected for the
umbrella target `photodermatoses`: its subtypes and exposure context must remain
separate.

## Non-negotiable limits

The SCIN label is a retrospective dermatologist differential, not a diagnosis.
The manifest is not a model release. Before any image download or experiment,
retain the SCIN attribution and license notices, keep contributions split-disjoint,
deduplicate against every other source, and evaluate a separately held-out set.
No output is to be presented as a diagnosis, medical triage, or a replacement
for professional care.
