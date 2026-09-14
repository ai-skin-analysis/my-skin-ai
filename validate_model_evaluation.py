"""Validate a reviewable independent-evaluation evidence package for a model.

This utility is deliberately separate from the web application's production
gate.  It checks that the documented evidence is internally consistent with a
specific model artifact, its metadata, and the 50-class catalog.  A passing
report means only that the evidence *format and integrity checks* passed; it
does not establish clinical validity or activate a model.

The independent evaluation itself must be carried out under an approved
protocol.  In particular, this script cannot inspect private patient identity
data and therefore cannot prove patient/lesion disjointness.  It requires a
traceable attestation and split-manifest digest instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_CATALOG = PROJECT_ROOT / 'disease_catalog.json'
SHA256_PATTERN = re.compile(r'^[a-fA-F0-9]{64}$')
REQUIRED_PROVENANCE_FIELDS = (
    'dataset_id',
    'source',
    'license',
    'approval_record',
    'manifest_sha256',
)
REQUIRED_MODEL_THRESHOLDS = (
    'abstention_threshold',
    'margin_threshold',
    'out_of_scope_threshold',
)


def sha256_file(path: Path) -> str:
    """Return a SHA-256 digest without loading a model or document into memory."""
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError as error:
        raise ValueError(f'{label} does not exist: {path}') from error
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f'Could not read {label}: {error}') from error
    if not isinstance(value, dict):
        raise ValueError(f'{label} must contain a JSON object.')
    return value


def load_catalog(path: Path) -> dict[str, dict[str, Any]]:
    data = read_json(path, 'disease catalog')
    classes = data.get('classes')
    if not isinstance(classes, list) or len(classes) != 50:
        raise ValueError('Disease catalog must contain exactly 50 classes.')
    catalog: dict[str, dict[str, Any]] = {}
    for item in classes:
        class_id = item.get('id') if isinstance(item, dict) else None
        label = item.get('label') if isinstance(item, dict) else None
        group = item.get('group') if isinstance(item, dict) else None
        if not isinstance(class_id, str) or not class_id.strip():
            raise ValueError('Disease catalog contains an invalid class id.')
        if class_id in catalog:
            raise ValueError(f'Disease catalog contains duplicate class id: {class_id}')
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f'Disease catalog class {class_id} has an invalid label.')
        if group not in {'clinical', 'lesion'}:
            raise ValueError(f'Disease catalog class {class_id} has an invalid group.')
        catalog[class_id] = item
    return catalog


def _append_problem(problems: list[str], text: str) -> None:
    if text not in problems:
        problems.append(text)


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_sha256(value: Any) -> bool:
    return _is_nonempty_string(value) and bool(SHA256_PATTERN.fullmatch(value))


def _is_number_between_zero_and_one(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and 0.0 <= float(value) <= 1.0
    )


def _is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _is_iso_datetime(value: Any) -> bool:
    if not _is_nonempty_string(value):
        return False
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return False
    return True


def _validate_provenance(value: Any, label: str, problems: list[str]) -> None:
    if not isinstance(value, dict):
        _append_problem(problems, f'{label} must be an object with dataset provenance.')
        return
    for field in REQUIRED_PROVENANCE_FIELDS:
        field_value = value.get(field)
        if field == 'manifest_sha256':
            valid = _is_sha256(field_value)
        else:
            valid = _is_nonempty_string(field_value)
        if not valid:
            _append_problem(problems, f'{label}.{field} is missing or invalid.')


def _validate_class_contract(
    class_ids: Any,
    class_names: Any,
    catalog: dict[str, dict[str, Any]],
    label: str,
    problems: list[str],
    *,
    expected_order: list[str] | None = None,
) -> list[str]:
    if not isinstance(class_ids, list) or not all(_is_nonempty_string(value) for value in class_ids):
        _append_problem(problems, f'{label}.class_ids must be a non-empty list of class ids.')
        return []
    if not isinstance(class_names, list) or len(class_names) != len(class_ids) or not all(_is_nonempty_string(value) for value in class_names):
        _append_problem(problems, f'{label}.class_names must match class_ids one-for-one.')
        return []
    if len(set(class_ids)) != len(class_ids):
        _append_problem(problems, f'{label}.class_ids contains duplicate ids.')
    unknown = sorted(set(class_ids) - set(catalog))
    missing = sorted(set(catalog) - set(class_ids))
    if unknown or missing or len(class_ids) != len(catalog):
        _append_problem(
            problems,
            f'{label} must cover exactly the 50 catalog classes (missing={len(missing)}, unknown={len(unknown)}).',
        )
    for class_id, class_name in zip(class_ids, class_names):
        item = catalog.get(class_id)
        if item and class_name != item['label']:
            _append_problem(problems, f'{label} label/order does not match the catalog at {class_id}.')
            break
    if expected_order is not None and class_ids != expected_order:
        _append_problem(problems, f'{label}.class_ids order does not match the model metadata.')
    return list(class_ids)


def _validate_metric_record(value: Any, label: str, problems: list[str]) -> None:
    if not isinstance(value, dict):
        _append_problem(problems, f'{label} must be an object.')
        return
    if not _is_positive_int(value.get('support')):
        _append_problem(problems, f'{label}.support must be a positive integer.')
    for metric in ('recall', 'precision'):
        if not _is_number_between_zero_and_one(value.get(metric)):
            _append_problem(problems, f'{label}.{metric} must be a finite number between 0 and 1.')
    interval = value.get('recall_ci_95')
    if not isinstance(interval, dict) or not _is_number_between_zero_and_one(interval.get('lower')) or not _is_number_between_zero_and_one(interval.get('upper')):
        _append_problem(problems, f'{label}.recall_ci_95 must contain lower and upper values between 0 and 1.')
        return
    lower = float(interval['lower'])
    upper = float(interval['upper'])
    recall = value.get('recall')
    if lower > upper or (_is_number_between_zero_and_one(recall) and not lower <= float(recall) <= upper):
        _append_problem(problems, f'{label}.recall_ci_95 must contain the recorded recall.')


def _validate_per_class_metrics(value: Any, expected_ids: list[str], label: str, problems: list[str]) -> None:
    if not isinstance(value, dict):
        _append_problem(problems, f'{label} must be an object keyed by class id.')
        return
    present_ids = set(value)
    expected_set = set(expected_ids)
    if present_ids != expected_set:
        _append_problem(
            problems,
            f'{label} must include each expected class exactly once (missing={len(expected_set - present_ids)}, extra={len(present_ids - expected_set)}).',
        )
    for class_id in expected_ids:
        if class_id in value:
            _validate_metric_record(value[class_id], f'{label}.{class_id}', problems)


def _expected_domains(model_domain: Any, class_ids: list[str], catalog: dict[str, dict[str, Any]], problems: list[str]) -> dict[str, list[str]]:
    if model_domain not in {'clinical', 'dermoscopic', 'multi_domain'}:
        _append_problem(problems, 'metadata.model_input_domain must be clinical, dermoscopic, or multi_domain.')
        return {}
    if any(class_id not in catalog for class_id in class_ids):
        # The class-contract validator has already emitted the actionable
        # catalog error.  Avoid a secondary KeyError hiding that result.
        return {}
    clinical_ids = [class_id for class_id in class_ids if catalog[class_id]['group'] == 'clinical']
    dermoscopic_ids = [class_id for class_id in class_ids if catalog[class_id]['group'] == 'lesion']
    if model_domain == 'clinical':
        return {'clinical': class_ids}
    if model_domain == 'dermoscopic':
        return {'dermoscopic': class_ids}
    expected = {}
    if clinical_ids:
        expected['clinical'] = clinical_ids
    if dermoscopic_ids:
        expected['dermoscopic'] = dermoscopic_ids
    return expected


def _validate_domain_evidence(value: Any, expected: dict[str, list[str]], problems: list[str]) -> None:
    if not isinstance(value, dict):
        _append_problem(problems, 'evaluation.by_input_domain must be an object.')
        return
    present = set(value)
    expected_domains = set(expected)
    if present != expected_domains:
        _append_problem(
            problems,
            f'evaluation.by_input_domain must cover the model domains exactly (missing={len(expected_domains - present)}, extra={len(present - expected_domains)}).',
        )
    for domain, expected_ids in expected.items():
        entry = value.get(domain)
        if not isinstance(entry, dict):
            _append_problem(problems, f'evaluation.by_input_domain.{domain} must be an object.')
            continue
        if not _is_positive_int(entry.get('image_count')):
            _append_problem(problems, f'evaluation.by_input_domain.{domain}.image_count must be a positive integer.')
        if entry.get('class_ids') != expected_ids:
            _append_problem(problems, f'evaluation.by_input_domain.{domain}.class_ids must match the model classes for that domain.')
        _validate_per_class_metrics(entry.get('per_class_metrics'), expected_ids, f'evaluation.by_input_domain.{domain}.per_class_metrics', problems)


def _validate_calibration_and_ood(value: Any, metadata: dict[str, Any], problems: list[str]) -> None:
    if not isinstance(value, dict):
        _append_problem(problems, 'evaluation.calibration_and_ood must be an object.')
        return
    if not _is_nonempty_string(value.get('method')):
        _append_problem(problems, 'evaluation.calibration_and_ood.method is required.')
    if not _is_iso_datetime(value.get('validated_at')):
        _append_problem(problems, 'evaluation.calibration_and_ood.validated_at must be an ISO-8601 timestamp.')
    _validate_provenance(value.get('calibration_dataset'), 'evaluation.calibration_and_ood.calibration_dataset', problems)
    if not _is_number_between_zero_and_one(value.get('expected_calibration_error')):
        _append_problem(problems, 'evaluation.calibration_and_ood.expected_calibration_error must be between 0 and 1.')

    thresholds = value.get('thresholds')
    if not isinstance(thresholds, dict):
        _append_problem(problems, 'evaluation.calibration_and_ood.thresholds must be an object.')
    else:
        for threshold_name in REQUIRED_MODEL_THRESHOLDS:
            expected = metadata.get(threshold_name)
            observed = thresholds.get(threshold_name)
            if not _is_number_between_zero_and_one(observed):
                _append_problem(problems, f'evaluation.calibration_and_ood.thresholds.{threshold_name} must be between 0 and 1.')
            elif not _is_number_between_zero_and_one(expected) or not math.isclose(float(observed), float(expected), abs_tol=1e-12):
                _append_problem(problems, f'evaluation.calibration_and_ood.thresholds.{threshold_name} must match metadata.')
        abstention = thresholds.get('abstention_threshold')
        out_of_scope = thresholds.get('out_of_scope_threshold')
        if _is_number_between_zero_and_one(abstention) and _is_number_between_zero_and_one(out_of_scope) and float(out_of_scope) > float(abstention):
            _append_problem(problems, 'evaluation.calibration_and_ood out_of_scope_threshold cannot exceed abstention_threshold.')

    ood = value.get('ood_evaluation')
    if not isinstance(ood, dict):
        _append_problem(problems, 'evaluation.calibration_and_ood.ood_evaluation must be an object.')
        return
    _validate_provenance(ood.get('dataset'), 'evaluation.calibration_and_ood.ood_evaluation.dataset', problems)
    if not _is_positive_int(ood.get('image_count')):
        _append_problem(problems, 'evaluation.calibration_and_ood.ood_evaluation.image_count must be a positive integer.')
    if not _is_nonempty_string(ood.get('definition')):
        _append_problem(problems, 'evaluation.calibration_and_ood.ood_evaluation.definition is required.')
    if not _is_number_between_zero_and_one(ood.get('false_accept_rate')):
        _append_problem(problems, 'evaluation.calibration_and_ood.ood_evaluation.false_accept_rate must be between 0 and 1.')
    interval = ood.get('false_accept_rate_ci_95')
    if not isinstance(interval, dict) or not _is_number_between_zero_and_one(interval.get('lower')) or not _is_number_between_zero_and_one(interval.get('upper')):
        _append_problem(problems, 'evaluation.calibration_and_ood.ood_evaluation.false_accept_rate_ci_95 must contain lower and upper values between 0 and 1.')
    elif float(interval['lower']) > float(interval['upper']) or not float(interval['lower']) <= float(ood.get('false_accept_rate', -1)) <= float(interval['upper']):
        _append_problem(problems, 'evaluation.calibration_and_ood.ood_evaluation false-accept interval must contain false_accept_rate.')


def _validate_release_review(value: Any, problems: list[str]) -> None:
    if not isinstance(value, dict):
        _append_problem(problems, 'evaluation.release_review must be an object; evidence cannot self-approve a release.')
        return
    if not _is_nonempty_string(value.get('intended_use')):
        _append_problem(problems, 'evaluation.release_review.intended_use is required.')
    if not _is_nonempty_string(value.get('reviewed_by')):
        _append_problem(problems, 'evaluation.release_review.reviewed_by is required.')
    if not _is_iso_datetime(value.get('reviewed_at')):
        _append_problem(problems, 'evaluation.release_review.reviewed_at must be an ISO-8601 timestamp.')
    if not _is_nonempty_string(value.get('approval_reference')):
        _append_problem(problems, 'evaluation.release_review.approval_reference is required.')
    if value.get('approved_for_clinical_screening') is not True:
        _append_problem(problems, 'evaluation.release_review.approved_for_clinical_screening must be true after human approval.')


def _metric_template() -> dict[str, Any]:
    """Return intentionally invalid placeholders for one reviewed class metric."""
    return {
        'support': 0,
        'recall': 0.0,
        'precision': 0.0,
        'recall_ci_95': {'lower': 0.0, 'upper': 0.0},
    }


def build_evaluation_manifest_template(
    metadata: dict[str, Any],
    catalog: dict[str, dict[str, Any]],
    *,
    metadata_sha256: str | None = None,
) -> dict[str, Any]:
    """Build a non-approved template bound to one candidate's output order.

    The generated values are placeholders.  It is useful because the reviewer
    cannot accidentally omit one of the model's 50 outputs or use an order
    different from the model metadata.
    """
    class_ids = list(metadata.get('class_ids') or [])
    class_names = list(metadata.get('class_names') or [])
    template_provenance = {
        'dataset_id': 'REPLACE_WITH_APPROVED_EVALUATION_DATASET_ID',
        'source': 'REPLACE_WITH_APPROVED_SOURCE_URL_OR_INTERNAL_ID',
        'license': 'REPLACE_WITH_LICENSE_OR_DUA',
        'approval_record': 'REPLACE_WITH_DATA_GOVERNANCE_APPROVAL_REFERENCE',
        'manifest_sha256': 'REPLACE_WITH_64_CHARACTER_SHA256',
    }
    template_metrics = {class_id: _metric_template() for class_id in class_ids}
    domains: dict[str, Any] = {}
    expected_domains = _expected_domains(metadata.get('model_input_domain'), class_ids, catalog, [])
    for domain, domain_ids in expected_domains.items():
        domains[domain] = {
            'image_count': 0,
            'class_ids': domain_ids,
            'per_class_metrics': {class_id: _metric_template() for class_id in domain_ids},
        }
    return {
        'schema_version': 1,
        'evaluation_id': 'REPLACE_WITH_REVIEWED_EVALUATION_ID',
        'evaluation_date': 'REPLACE_WITH_ISO_8601_TIMESTAMP',
        'model': {
            'model_version': metadata.get('model_version', 'REPLACE_WITH_MODEL_VERSION'),
            'artifact_sha256': metadata.get('artifact_sha256', 'REPLACE_WITH_64_CHARACTER_SHA256'),
            'metadata_sha256': metadata_sha256 or 'REPLACE_WITH_64_CHARACTER_SHA256',
            'class_ids': class_ids,
            'class_names': class_names,
        },
        'evaluation_dataset': template_provenance,
        'independence': {
            'patient_or_lesion_disjoint': False,
            'split_unit': 'REPLACE_WITH_patient_OR_lesion_OR_patient_and_lesion',
            'split_manifest_sha256': 'REPLACE_WITH_64_CHARACTER_SHA256',
            'reviewed_by': 'REPLACE_WITH_INDEPENDENT_REVIEWER',
            'reviewed_at': 'REPLACE_WITH_ISO_8601_TIMESTAMP',
            'review_reference': 'REPLACE_WITH_SPLIT_AUDIT_REFERENCE',
        },
        'overall_metrics': {'image_count': 0, 'accuracy': 0.0},
        'per_class_metrics': template_metrics,
        'by_input_domain': domains,
        'calibration_and_ood': {
            'method': 'REPLACE_WITH_CALIBRATION_METHOD',
            'validated_at': 'REPLACE_WITH_ISO_8601_TIMESTAMP',
            'calibration_dataset': dict(template_provenance),
            'expected_calibration_error': 0.0,
            'thresholds': {
                threshold_name: metadata.get(threshold_name, 0.0)
                for threshold_name in REQUIRED_MODEL_THRESHOLDS
            },
            'ood_evaluation': {
                'dataset': {
                    'dataset_id': 'REPLACE_WITH_APPROVED_OOD_DATASET_ID',
                    'source': 'REPLACE_WITH_APPROVED_SOURCE_URL_OR_INTERNAL_ID',
                    'license': 'REPLACE_WITH_LICENSE_OR_DUA',
                    'approval_record': 'REPLACE_WITH_DATA_GOVERNANCE_APPROVAL_REFERENCE',
                    'manifest_sha256': 'REPLACE_WITH_64_CHARACTER_SHA256',
                },
                'image_count': 0,
                'definition': 'REPLACE_WITH_OUT_OF_SCOPE_DEFINITION',
                'false_accept_rate': 0.0,
                'false_accept_rate_ci_95': {'lower': 0.0, 'upper': 0.0},
            },
        },
        'release_review': {
            'intended_use': 'REPLACE_WITH_REVIEWED_INTENDED_USE',
            'reviewed_by': 'REPLACE_WITH_RESPONSIBLE_CLINICAL_REVIEWER',
            'reviewed_at': 'REPLACE_WITH_ISO_8601_TIMESTAMP',
            'approval_reference': 'REPLACE_WITH_RELEASE_APPROVAL_REFERENCE',
            'approved_for_clinical_screening': False,
        },
        'template_notice': (
            'This is an unapproved template. Complete it from an independent evaluation; '
            'validation only checks evidence structure and integrity and never activates a model.'
        ),
    }


def validate_evaluation_evidence(
    metadata: dict[str, Any],
    evaluation: dict[str, Any],
    catalog: dict[str, dict[str, Any]],
    *,
    metadata_sha256: str | None = None,
    artifact_sha256: str | None = None,
) -> dict[str, Any]:
    """Check internal consistency of model metadata and independent evidence."""
    problems: list[str] = []
    warnings: list[str] = []

    if evaluation.get('schema_version') != 1:
        _append_problem(problems, 'evaluation.schema_version must be 1.')
    if not _is_nonempty_string(evaluation.get('evaluation_id')):
        _append_problem(problems, 'evaluation.evaluation_id is required.')
    if not _is_iso_datetime(evaluation.get('evaluation_date')):
        _append_problem(problems, 'evaluation.evaluation_date must be an ISO-8601 timestamp.')

    model_class_ids = _validate_class_contract(
        metadata.get('class_ids'), metadata.get('class_names'), catalog, 'metadata', problems
    )
    _validate_provenance(metadata.get('dataset_manifest'), 'metadata.dataset_manifest', problems)
    for threshold_name in REQUIRED_MODEL_THRESHOLDS:
        if not _is_number_between_zero_and_one(metadata.get(threshold_name)):
            _append_problem(problems, f'metadata.{threshold_name} must be a finite number between 0 and 1.')
    if _is_number_between_zero_and_one(metadata.get('out_of_scope_threshold')) and _is_number_between_zero_and_one(metadata.get('abstention_threshold')) and float(metadata['out_of_scope_threshold']) > float(metadata['abstention_threshold']):
        _append_problem(problems, 'metadata.out_of_scope_threshold cannot exceed abstention_threshold.')
    if not _is_sha256(metadata.get('artifact_sha256')):
        _append_problem(problems, 'metadata.artifact_sha256 must be a SHA-256 digest.')
    if artifact_sha256 is None:
        _append_problem(problems, 'A model artifact must be supplied so its SHA-256 can be verified.')
    elif metadata.get('artifact_sha256', '').casefold() != artifact_sha256.casefold():
        _append_problem(problems, 'Model artifact SHA-256 does not match metadata.artifact_sha256.')

    model_reference = evaluation.get('model')
    if not isinstance(model_reference, dict):
        _append_problem(problems, 'evaluation.model must be an object.')
    else:
        if not _is_nonempty_string(model_reference.get('model_version')) or model_reference.get('model_version') != metadata.get('model_version'):
            _append_problem(problems, 'evaluation.model.model_version must match metadata.model_version.')
        if str(model_reference.get('artifact_sha256', '')).casefold() != str(metadata.get('artifact_sha256', '')).casefold():
            _append_problem(problems, 'evaluation.model.artifact_sha256 must match metadata.artifact_sha256.')
        if metadata_sha256 is None:
            _append_problem(problems, 'Metadata SHA-256 could not be calculated.')
        elif str(model_reference.get('metadata_sha256', '')).casefold() != metadata_sha256.casefold():
            _append_problem(problems, 'evaluation.model.metadata_sha256 must match the supplied metadata file.')
        _validate_class_contract(
            model_reference.get('class_ids'),
            model_reference.get('class_names'),
            catalog,
            'evaluation.model',
            problems,
            expected_order=model_class_ids or None,
        )

    _validate_provenance(evaluation.get('evaluation_dataset'), 'evaluation.evaluation_dataset', problems)
    independence = evaluation.get('independence')
    if not isinstance(independence, dict):
        _append_problem(problems, 'evaluation.independence must be an object.')
    else:
        if independence.get('patient_or_lesion_disjoint') is not True:
            _append_problem(problems, 'evaluation.independence.patient_or_lesion_disjoint must be true.')
        if independence.get('split_unit') not in {'patient', 'lesion', 'patient_and_lesion'}:
            _append_problem(problems, 'evaluation.independence.split_unit must describe the patient/lesion split.')
        if not _is_sha256(independence.get('split_manifest_sha256')):
            _append_problem(problems, 'evaluation.independence.split_manifest_sha256 must be a SHA-256 digest.')
        if not _is_nonempty_string(independence.get('reviewed_by')):
            _append_problem(problems, 'evaluation.independence.reviewed_by is required.')
        if not _is_iso_datetime(independence.get('reviewed_at')):
            _append_problem(problems, 'evaluation.independence.reviewed_at must be an ISO-8601 timestamp.')
        if not _is_nonempty_string(independence.get('review_reference')):
            _append_problem(problems, 'evaluation.independence.review_reference is required.')

    overall_metrics = evaluation.get('overall_metrics')
    if not isinstance(overall_metrics, dict) or not _is_positive_int(overall_metrics.get('image_count')) or not _is_number_between_zero_and_one(overall_metrics.get('accuracy')):
        _append_problem(problems, 'evaluation.overall_metrics must include positive image_count and accuracy between 0 and 1.')
    _validate_per_class_metrics(evaluation.get('per_class_metrics'), model_class_ids, 'evaluation.per_class_metrics', problems)
    expected_domains = _expected_domains(metadata.get('model_input_domain'), model_class_ids, catalog, problems) if model_class_ids else {}
    _validate_domain_evidence(evaluation.get('by_input_domain'), expected_domains, problems)
    _validate_calibration_and_ood(evaluation.get('calibration_and_ood'), metadata, problems)
    _validate_release_review(evaluation.get('release_review'), problems)

    return {
        'schema_version': 1,
        'evidence_format_valid': not problems,
        'problems': problems,
        'warnings': warnings,
        'human_review_required': True,
        'not_a_clinical_validity_or_deployment_approval': True,
    }


def validate_paths(
    metadata_path: Path,
    evaluation_path: Path,
    model_path: Path,
    catalog_path: Path = DEFAULT_CATALOG,
) -> dict[str, Any]:
    """Load JSON/artifacts and return a serializable validation report."""
    metadata_path = Path(metadata_path).resolve()
    evaluation_path = Path(evaluation_path).resolve()
    model_path = Path(model_path).resolve()
    catalog_path = Path(catalog_path).resolve()
    metadata = read_json(metadata_path, 'model metadata')
    evaluation = read_json(evaluation_path, 'independent evaluation manifest')
    catalog = load_catalog(catalog_path)
    if not model_path.is_file():
        raise ValueError(f'Model artifact does not exist: {model_path}')
    report = validate_evaluation_evidence(
        metadata,
        evaluation,
        catalog,
        metadata_sha256=sha256_file(metadata_path),
        artifact_sha256=sha256_file(model_path),
    )
    report.update({
        'metadata_path': str(metadata_path),
        'evaluation_manifest_path': str(evaluation_path),
        'model_path': str(model_path),
        'catalog_path': str(catalog_path),
        'metadata_sha256': sha256_file(metadata_path),
        'artifact_sha256': sha256_file(model_path),
    })
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Validate a provenance-bound independent evaluation package. This never activates a model.'
    )
    parser.add_argument('--metadata', type=Path, required=True, help='Candidate .metadata.json produced with the model.')
    parser.add_argument('--evaluation-manifest', type=Path, required=True, help='Reviewed independent evaluation evidence JSON.')
    parser.add_argument('--model', type=Path, required=True, help='Candidate model artifact whose hash must match metadata.')
    parser.add_argument('--catalog', type=Path, default=DEFAULT_CATALOG)
    parser.add_argument('--output', type=Path, help='Optional path for the JSON report.')
    parser.add_argument('--json', action='store_true', help='Print JSON instead of a compact text report.')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = validate_paths(args.metadata, args.evaluation_manifest, args.model, args.catalog)
    except ValueError as error:
        print(f'Error: {error}')
        return 2
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print('Evidence format valid: ' + ('yes' if report['evidence_format_valid'] else 'no'))
        print('Human review required: yes')
        print('This command does not activate or clinically validate a model.')
        for problem in report['problems']:
            print('- ' + problem)
    return 0 if report['evidence_format_valid'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
