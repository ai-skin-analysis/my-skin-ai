"""Create a reviewable per-file candidate mapping for archive.zip.

This tool never extracts images, moves images into a training directory, alters
the active model, or treats a filename as a medically verified diagnosis.  It
only records transparent candidate labels based on ``archive_mapping_rules.json``
so a qualified reviewer can approve or reject each image before it is used.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import zipfile
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_ARCHIVE = PROJECT_ROOT / 'archive.zip'
DEFAULT_RULES = PROJECT_ROOT / 'archive_mapping_rules.json'
DEFAULT_CATALOG = PROJECT_ROOT / 'disease_catalog.json'
DEFAULT_OUTPUT = PROJECT_ROOT / 'dataset' / 'multiclass' / 'archive_file_mapping.csv'
DEFAULT_REPORT = PROJECT_ROOT / 'dataset' / 'multiclass' / 'archive_file_mapping.report.json'
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


def sha256_file(path: Path) -> str:
    """Return a stable provenance digest for a reviewed mapping input/output."""
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f'Unable to read {path}: {error}') from error


def load_catalog(path: Path) -> dict[str, dict]:
    data = load_json(path)
    items = data.get('classes')
    if not isinstance(items, list) or len(items) != 50:
        raise ValueError('disease_catalog.json must contain exactly 50 classes.')
    catalog = {item.get('id'): item for item in items}
    if len(catalog) != 50 or not all(catalog):
        raise ValueError('disease_catalog.json contains invalid or duplicate class IDs.')
    return catalog


def normalize_filename(filename: str) -> str:
    """Make separators and CamelCase labels comparable without using folders."""
    filename = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', ' ', filename)
    filename = re.sub(r'(?<=[A-Za-z])(?=[0-9])', ' ', filename)
    filename = re.sub(r'(?<=[0-9])(?=[A-Za-z])', ' ', filename)
    filename = filename.casefold()
    filename = re.sub(r'[^a-z0-9]+', ' ', filename)
    return f" {' '.join(filename.split())} "


def phrase_in_filename(normalized_filename: str, phrase: str) -> bool:
    normalized_phrase = normalize_filename(phrase)
    return normalized_phrase.strip() and normalized_phrase in normalized_filename


def validate_rules(data: dict, catalog: dict[str, dict]) -> tuple[list[dict], list[str]]:
    rules = data.get('rules')
    policy = data.get('matching_policy')
    if not isinstance(rules, list) or not isinstance(policy, dict):
        raise ValueError('Mapping rules require rules[] and matching_policy.')
    rule_ids = [rule.get('target_id') for rule in rules]
    if len(rule_ids) != 50 or set(rule_ids) != set(catalog):
        missing = sorted(set(catalog) - set(rule_ids))
        unexpected = sorted(set(rule_ids) - set(catalog))
        raise ValueError(f'Mapping rules must cover each catalog ID once (missing={missing}, unexpected={unexpected}).')
    if any(not isinstance(rule.get('include_any'), list) or not rule['include_any'] for rule in rules):
        raise ValueError('Every mapping rule must declare at least one include_any phrase.')
    excluded = policy.get('excluded_filename_terms')
    if not isinstance(excluded, list) or not all(isinstance(term, str) for term in excluded):
        raise ValueError('matching_policy.excluded_filename_terms must be a list of strings.')
    return rules, excluded


def map_member(member_name: str, rules: list[dict], excluded_terms: list[str], catalog: dict[str, dict]) -> dict:
    source_filename = Path(member_name).name
    normalized = normalize_filename(source_filename)
    source_parts = member_name.split('/')
    split = source_parts[0] if source_parts else ''
    source_folder = source_parts[1] if len(source_parts) > 1 else ''

    row = {
        'source_member': member_name,
        'source_split': split,
        'source_folder': source_folder,
        'source_filename': source_filename,
        'target_id': '',
        'target_name_en': '',
        'target_name_th': '',
        'mapping_status': '',
        'matched_rule': '',
        'review_decision': 'pending',
        'reviewer': '',
        'reviewed_at': '',
        'review_notes': '',
    }

    if Path(source_filename).suffix.casefold() not in IMAGE_EXTENSIONS:
        row['mapping_status'] = 'excluded_not_an_image'
        return row
    if any(phrase_in_filename(normalized, term) for term in excluded_terms):
        row['mapping_status'] = 'excluded_nonclinical_or_unsupported_modality'
        return row

    matches = []
    for rule in rules:
        matched_phrases = [phrase for phrase in rule['include_any'] if phrase_in_filename(normalized, phrase)]
        if matched_phrases:
            matches.append((rule['target_id'], matched_phrases))

    if len(matches) == 1:
        target_id, phrases = matches[0]
        target = catalog[target_id]
        row.update({
            'target_id': target_id,
            'target_name_en': target['name_en'],
            'target_name_th': target['name_th'],
            'mapping_status': 'candidate_direct_filename_review_required',
            'matched_rule': ' | '.join(phrases),
        })
    elif len(matches) > 1:
        row.update({
            'target_id': ' | '.join(target_id for target_id, _ in matches),
            'mapping_status': 'needs_manual_review_multiple_candidates',
            'matched_rule': ' | '.join(
                f"{target_id}: {', '.join(phrases)}" for target_id, phrases in matches
            ),
        })
    else:
        row['mapping_status'] = 'unmapped_manual_review_required'
    return row


def create_mapping(archive_path: Path, rules_path: Path, catalog_path: Path, output_path: Path, report_path: Path) -> dict:
    if not archive_path.is_file():
        raise FileNotFoundError(f'Archive not found: {archive_path}')
    catalog = load_catalog(catalog_path)
    rules_data = load_json(rules_path)
    rules, excluded_terms = validate_rules(rules_data, catalog)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fields = [
        'source_member', 'source_split', 'source_folder', 'source_filename',
        'target_id', 'target_name_en', 'target_name_th', 'mapping_status',
        'matched_rule', 'review_decision', 'reviewer', 'reviewed_at', 'review_notes',
    ]
    status_counts: Counter[str] = Counter()
    candidate_counts: Counter[str] = Counter()
    image_count = 0
    with zipfile.ZipFile(archive_path) as archive, output_path.open('w', encoding='utf-8-sig', newline='') as mapping_file:
        writer = csv.DictWriter(mapping_file, fieldnames=fields)
        writer.writeheader()
        for info in archive.infolist():
            if info.is_dir():
                continue
            row = map_member(info.filename, rules, excluded_terms, catalog)
            writer.writerow(row)
            status_counts[row['mapping_status']] += 1
            if Path(row['source_filename']).suffix.casefold() in IMAGE_EXTENSIONS:
                image_count += 1
            if row['mapping_status'] == 'candidate_direct_filename_review_required':
                candidate_counts[row['target_id']] += 1

    report = {
        'schema_version': 1,
        'archive': str(archive_path),
        'archive_sha256': sha256_file(archive_path),
        'rules': str(rules_path),
        'rules_sha256': sha256_file(rules_path),
        'catalog': str(catalog_path),
        'catalog_sha256': sha256_file(catalog_path),
        'output': str(output_path),
        'output_sha256': sha256_file(output_path),
        'total_members': sum(status_counts.values()),
        'image_members': image_count,
        'mapping_status_counts': dict(sorted(status_counts.items())),
        'candidate_counts_by_target_id': {class_id: candidate_counts.get(class_id, 0) for class_id in catalog},
        'classes_without_candidate': [class_id for class_id in catalog if not candidate_counts.get(class_id)],
        'approval_required_before_training': True,
        'notes': [
            'A candidate is based on a source filename, not image inspection or a medical diagnosis.',
            'Do not extract, train, or activate a class until an authorized reviewer records an approval decision for the selected files and source provenance is complete.',
            'Rows marked unmapped or multiple candidates must not be auto-assigned.',
        ],
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Create a review-required per-file mapping from archive.zip to the 50-class catalog.')
    parser.add_argument('--archive', type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument('--rules', type=Path, default=DEFAULT_RULES)
    parser.add_argument('--catalog', type=Path, default=DEFAULT_CATALOG)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--report', type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


if __name__ == '__main__':
    args = parse_args()
    report = create_mapping(args.archive.resolve(), args.rules.resolve(), args.catalog.resolve(), args.output.resolve(), args.report.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
