"""Create and audit the safe input structure for the 50-class training set.

This utility only creates empty class folders and documentation templates.  It
never invents medical images, labels, provenance, approval, or evaluation data.
"""

import argparse
import csv
import hashlib
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
CATALOG_PATH = PROJECT_ROOT / 'disease_catalog.json'
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


def load_catalog():
    data = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
    classes = data.get('classes', [])
    if not isinstance(classes, list) or len(classes) != 50:
        raise ValueError('Expected exactly 50 classes in disease_catalog.json.')
    ids = [item.get('id') for item in classes]
    if not all(isinstance(class_id, str) and class_id for class_id in ids) or len(set(ids)) != 50:
        raise ValueError('Disease catalog has invalid or duplicate class ids.')
    return classes


def image_files(folder):
    if not folder.is_dir():
        return []
    return sorted(
        path for path in folder.rglob('*')
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as image_file:
        for block in iter(lambda: image_file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def manifest_template(classes):
    return {
        'schema_version': 1,
        'dataset_id': 'REPLACE_WITH_APPROVED_DATASET_ID',
        'source': 'REPLACE_WITH_APPROVED_SOURCE_URL_OR_INTERNAL_ID',
        'license': 'REPLACE_WITH_LICENSE_OR_DUA',
        'approval_record': 'REPLACE_WITH_DATA_GOVERNANCE_APPROVAL_REFERENCE',
        # This remains false until a real data owner/reviewer approves use.
        'approved_for_training': False,
        'class_ids': [item['id'] for item in classes],
    }


def write_scaffold(data_dir, classes, overwrite=False):
    """Create missing folders and non-active mapping/manifest templates."""
    data_dir.mkdir(parents=True, exist_ok=True)
    for item in classes:
        (data_dir / item['id']).mkdir(exist_ok=True)

    mapping_path = data_dir / 'class_mapping.csv'
    if overwrite or not mapping_path.exists():
        with mapping_path.open('w', encoding='utf-8', newline='') as mapping_file:
            writer = csv.DictWriter(
                mapping_file,
                fieldnames=['id', 'name_en', 'name_th', 'group', 'legacy_model'],
            )
            writer.writeheader()
            for item in classes:
                writer.writerow({
                    'id': item['id'],
                    'name_en': item.get('name_en', item['label']),
                    'name_th': item.get('name_th', item['label']),
                    'group': item.get('group', ''),
                    'legacy_model': item.get('legacy_model', False),
                })

    template_path = data_dir / 'dataset_manifest.template.json'
    if overwrite or not template_path.exists():
        template_path.write_text(
            json.dumps(manifest_template(classes), ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8',
        )
    return {'mapping_path': mapping_path, 'template_path': template_path}


def inspect_dataset(data_dir, classes, minimum_images, check_duplicates=False):
    """Report whether real labelled images and an approved manifest are present."""
    expected_ids = {item['id'] for item in classes}
    unexpected_class_folders = sorted(
        path.name for path in data_dir.iterdir()
        if path.is_dir() and not path.name.startswith('.') and path.name not in expected_ids
    ) if data_dir.is_dir() else []
    class_counts = {}
    missing_folders = []
    below_minimum = []
    image_hashes = {}
    for item in classes:
        class_id = item['id']
        folder = data_dir / class_id
        if not folder.is_dir():
            missing_folders.append(class_id)
            class_counts[class_id] = 0
            continue
        files = image_files(folder)
        count = len(files)
        class_counts[class_id] = count
        if count < minimum_images:
            below_minimum.append(class_id)
        if check_duplicates:
            for image_path in files:
                image_hashes.setdefault(sha256_file(image_path), []).append(
                    f'{class_id}/{image_path.name}'
                )

    active_manifest = data_dir / 'dataset_manifest.json'
    manifest_status = 'missing'
    if active_manifest.is_file():
        try:
            manifest = json.loads(active_manifest.read_text(encoding='utf-8'))
            manifest_status = 'approved' if manifest.get('approved_for_training') else 'not_approved'
        except (OSError, json.JSONDecodeError):
            manifest_status = 'invalid'

    duplicate_groups = [paths for paths in image_hashes.values() if len(paths) > 1] if check_duplicates else []
    return {
        'target_class_count': len(classes),
        'minimum_images_per_class': minimum_images,
        'image_count_total': sum(class_counts.values()),
        'class_counts': class_counts,
        'unexpected_class_folders': unexpected_class_folders,
        'missing_folders': missing_folders,
        'classes_below_minimum': below_minimum,
        'manifest_status': manifest_status,
        'duplicates_checked': check_duplicates,
        'duplicate_image_groups': duplicate_groups[:20],
        'duplicate_image_group_count': len(duplicate_groups),
        'ready_for_training': (
            not missing_folders
            and not below_minimum
            and not unexpected_class_folders
            and manifest_status == 'approved'
            and check_duplicates
            and not duplicate_groups
        ),
    }


def format_report(report):
    lines = [
        f"Target classes: {report['target_class_count']}",
        f"Images found: {report['image_count_total']}",
        f"Minimum per class: {report['minimum_images_per_class']}",
        f"Manifest: {report['manifest_status']}",
        f"Classes below minimum: {len(report['classes_below_minimum'])}",
        f"Unexpected class folders: {len(report['unexpected_class_folders'])}",
        f"Duplicate check: {'completed' if report['duplicates_checked'] else 'not run'}",
        f"Duplicate image groups: {report['duplicate_image_group_count']}",
        f"Ready for training: {'yes' if report['ready_for_training'] else 'no'}",
    ]
    if report['classes_below_minimum']:
        lines.append('Below minimum: ' + ', '.join(report['classes_below_minimum']))
    if report['unexpected_class_folders']:
        lines.append('Unexpected folders: ' + ', '.join(report['unexpected_class_folders']))
    return '\n'.join(lines)


def parse_args():
    parser = argparse.ArgumentParser(description='Prepare or audit the real, labelled 50-class skin-image dataset.')
    parser.add_argument('--data-dir', default=str(PROJECT_ROOT / 'dataset' / 'multiclass'))
    parser.add_argument('--min-images', type=int, default=200)
    parser.add_argument('--scaffold', action='store_true', help='Create missing class folders plus safe templates without overwriting files.')
    parser.add_argument('--overwrite-templates', action='store_true', help='Replace only the mapping and manifest template, never image files.')
    parser.add_argument('--check-duplicates', action='store_true', help='Hash every image and reject repeated content before training.')
    parser.add_argument('--json', action='store_true', help='Print the report as JSON.')
    return parser.parse_args()


def main():
    args = parse_args()
    if args.min_images < 1:
        raise ValueError('--min-images must be at least 1.')
    classes = load_catalog()
    data_dir = Path(args.data_dir).resolve()
    if args.scaffold:
        files = write_scaffold(data_dir, classes, overwrite=args.overwrite_templates)
        print(f"Created/checked 50 class folders in: {data_dir}")
        print(f"Class mapping: {files['mapping_path']}")
        print(f"Manifest template: {files['template_path']}")

    report = inspect_dataset(data_dir, classes, args.min_images, check_duplicates=args.check_duplicates)
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else format_report(report))
    return 0 if report['ready_for_training'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
