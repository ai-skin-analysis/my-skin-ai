"""Build a non-active, contribution-safe SCIN candidate manifest.

This importer works from the official SCIN metadata CSV files.  It neither
downloads images nor trains or activates a model.  It preserves the original
source label, weight and SCIN case ID so an experimental data selection can be
audited without treating a differential label as a diagnosis.
"""

import argparse
import ast
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_CASES = PROJECT_ROOT / 'dataset' / 'source_data' / 'scin' / 'scin_cases.csv'
DEFAULT_LABELS = PROJECT_ROOT / 'dataset' / 'source_data' / 'scin' / 'scin_labels.csv'
DEFAULT_POLICY = PROJECT_ROOT / 'dataset' / 'multiclass' / 'scin_source_label_policy.json'
DEFAULT_CATALOG = PROJECT_ROOT / 'disease_catalog.json'
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / 'dataset' / 'multiclass' / 'scin_metadata_audit'


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source_file:
        for block in iter(lambda: source_file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def parse_weighted_labels(value):
    """Return a non-negative `{source_label: normalized_weight}` dictionary."""
    if not value:
        return {}
    try:
        parsed = ast.literal_eval(value)
    except (SyntaxError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    output = {}
    for label, weight in parsed.items():
        if not isinstance(label, str):
            continue
        try:
            numeric_weight = float(weight)
        except (TypeError, ValueError):
            continue
        if numeric_weight >= 0:
            output[label] = numeric_weight
    return output


def is_gradable(label_row):
    values = [
        value.strip()
        for key, value in label_row.items()
        if key.startswith('dermatologist_gradable_for_skin_condition_') and value
    ]
    return any(value in {'DEFAULT_YES_IMAGE_QUALITY_SUFFICIENT', 'YES'} for value in values)


def image_paths(case_row):
    return [
        case_row[key].strip()
        for key in ('image_1_path', 'image_2_path', 'image_3_path')
        if case_row.get(key, '').strip()
    ]


def resolve_case(label_row, case_row, mappings, minimum_primary_weight):
    """Select one conservative target or explain why the contribution is held out."""
    labels = parse_weighted_labels(label_row.get('weighted_skin_condition_label'))
    if not labels:
        return None, 'no_weighted_source_label', labels
    if not is_gradable(label_row):
        return None, 'not_dermatologist_gradable', labels
    paths = image_paths(case_row)
    if not paths:
        return None, 'no_image_path', labels

    highest_weight = max(labels.values())
    top_labels = sorted(label for label, weight in labels.items() if weight == highest_weight)
    if len(top_labels) != 1:
        return None, 'source_label_tie', labels

    primary_source_label = top_labels[0]
    mapping = mappings.get(primary_source_label)
    if not mapping:
        return None, 'primary_label_not_mapped', labels
    if not mapping.get('research_candidate', False):
        return None, 'mapping_requires_subtype_policy', labels
    if highest_weight < minimum_primary_weight:
        return None, 'primary_weight_below_threshold', labels
    return {
        'case_id': case_row['case_id'],
        'target_id': mapping['target_id'],
        'source_primary_label': primary_source_label,
        'source_primary_weight': f'{highest_weight:.6f}',
        'mapping_kind': mapping['mapping_kind'],
        'image_paths': json.dumps(paths, ensure_ascii=False),
        'weighted_source_labels': json.dumps(labels, ensure_ascii=False, sort_keys=True),
        'selection_status': 'research_candidate_only',
    }, None, labels


def create_audit(cases_path, labels_path, policy_path, catalog_path):
    policy = read_json(policy_path)
    catalog = read_json(catalog_path)
    catalog_ids = {item['id'] for item in catalog['classes']}
    mappings = policy['source_label_mappings']
    unknown_target_ids = sorted({item['target_id'] for item in mappings.values()} - catalog_ids)
    if unknown_target_ids:
        raise ValueError('Policy contains target ids absent from disease_catalog.json: ' + ', '.join(unknown_target_ids))
    if policy['selection'].get('allows_model_activation'):
        raise ValueError('SCIN metadata policy must never allow model activation.')

    with Path(cases_path).open(encoding='utf-8', newline='') as cases_file:
        cases = {row['case_id']: row for row in csv.DictReader(cases_file)}

    records = []
    skipped = Counter()
    source_label_counts = Counter()
    target_observed_case_counts = Counter()
    source_case_total = 0
    with Path(labels_path).open(encoding='utf-8', newline='') as labels_file:
        for label_row in csv.DictReader(labels_file):
            source_case_total += 1
            case_row = cases.get(label_row.get('case_id'))
            if not case_row:
                skipped['label_case_missing_from_cases_csv'] += 1
                continue
            selected, reason, labels = resolve_case(
                label_row,
                case_row,
                mappings,
                float(policy['selection']['minimum_primary_label_weight']),
            )
            source_label_counts.update(labels)
            if not selected:
                skipped[reason] += 1
                continue
            records.append(selected)
            target_observed_case_counts[selected['target_id']] += 1

    ordered_class_counts = {
        item['id']: target_observed_case_counts.get(item['id'], 0)
        for item in catalog['classes']
    }
    report = {
        'schema_version': 1,
        'status': 'research_metadata_audit_not_training_or_model_activation',
        'source': policy['source'],
        'selection': policy['selection'],
        'input': {
            'cases_csv': str(Path(cases_path).resolve()),
            'cases_csv_sha256': sha256(cases_path),
            'labels_csv': str(Path(labels_path).resolve()),
            'labels_csv_sha256': sha256(labels_path),
            'policy': str(Path(policy_path).resolve()),
            'policy_sha256': sha256(policy_path),
        },
        'source_case_total': source_case_total,
        'candidate_case_total': len(records),
        'candidate_image_total': sum(len(json.loads(record['image_paths'])) for record in records),
        'candidate_cases_by_target': ordered_class_counts,
        'targets_with_research_candidates': [target for target, count in ordered_class_counts.items() if count],
        'targets_without_research_candidates': [target for target, count in ordered_class_counts.items() if not count],
        'skipped_cases_by_reason': dict(sorted(skipped.items())),
        'observed_source_label_count': len(source_label_counts),
        'top_observed_source_labels': source_label_counts.most_common(50),
        'next_gate': 'A candidate manifest is not training data. Keep each SCIN contribution in exactly one split, download only after a licensed-data review, and keep every model inactive until independent evaluation is complete.',
    }
    return records, report


def write_audit(records, report, output_dir):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / 'scin_research_candidate_manifest.csv'
    report_path = output_dir / 'scin_metadata_coverage.report.json'
    fields = [
        'case_id', 'target_id', 'source_primary_label', 'source_primary_weight',
        'mapping_kind', 'image_paths', 'weighted_source_labels', 'selection_status',
    ]
    with manifest_path.open('w', encoding='utf-8', newline='') as manifest_file:
        writer = csv.DictWriter(manifest_file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(records)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return manifest_path, report_path


def parse_args():
    parser = argparse.ArgumentParser(description='Audit official SCIN metadata without downloading images or training a model.')
    parser.add_argument('--cases', default=str(DEFAULT_CASES))
    parser.add_argument('--labels', default=str(DEFAULT_LABELS))
    parser.add_argument('--policy', default=str(DEFAULT_POLICY))
    parser.add_argument('--catalog', default=str(DEFAULT_CATALOG))
    parser.add_argument('--output-dir', default=str(DEFAULT_OUTPUT_DIR))
    return parser.parse_args()


def main():
    args = parse_args()
    for value in (args.cases, args.labels, args.policy, args.catalog):
        if not Path(value).is_file():
            raise FileNotFoundError(f'Missing required source file: {value}')
    records, report = create_audit(args.cases, args.labels, args.policy, args.catalog)
    manifest_path, report_path = write_audit(records, report, args.output_dir)
    print(f'SCIN source cases: {report["source_case_total"]}')
    print(f'Research candidates: {report["candidate_case_total"]}')
    print(f'Candidate images (not downloaded): {report["candidate_image_total"]}')
    print(f'Candidate manifest: {manifest_path}')
    print(f'Coverage report: {report_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
