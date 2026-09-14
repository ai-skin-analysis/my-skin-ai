"""Train and evaluate a provenance-tracked multi-class skin-image screening model.

This command deliberately refuses tiny, unlabeled, or mixed-modality datasets by
default. It produces a model file plus adjacent metadata that the web app uses to
determine the only labels the model is allowed to display.
"""

import argparse
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import tensorflow as tf
from tensorflow.keras import layers
from tensorflow.keras.applications import MobileNetV2
from tensorflow.keras.callbacks import EarlyStopping, ModelCheckpoint

from validate_model_evaluation import build_evaluation_manifest_template


PROJECT_ROOT = Path(__file__).resolve().parent
CATALOG_PATH = PROJECT_ROOT / 'disease_catalog.json'
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}
IMAGE_SIZE = (224, 224)
DATASET_MANIFEST_NAME = 'dataset_manifest.json'


def load_catalog():
    data = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
    classes = data.get('classes', [])
    if not isinstance(classes, list) or len(classes) != 50:
        raise ValueError('disease_catalog.json must contain exactly 50 classes.')
    catalog = {}
    for entry in classes:
        class_id = entry.get('id') if isinstance(entry, dict) else None
        label = entry.get('label') if isinstance(entry, dict) else None
        group = entry.get('group') if isinstance(entry, dict) else None
        if not isinstance(class_id, str) or not class_id.strip() or class_id in catalog:
            raise ValueError('disease_catalog.json contains invalid or duplicate class ids.')
        if not isinstance(label, str) or not label.strip() or group not in {'clinical', 'lesion'}:
            raise ValueError(f'disease_catalog.json contains invalid label/group for {class_id}.')
        catalog[class_id] = entry
    return catalog


def image_files(folder):
    return sorted(file_path for file_path in folder.rglob('*') if file_path.is_file() and file_path.suffix.lower() in IMAGE_EXTENSIONS)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as image_file:
        for block in iter(lambda: image_file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def load_dataset_manifest(manifest_path, dataset_source, dataset_license, class_ids):
    if not manifest_path.is_file():
        raise ValueError(f'Missing required dataset manifest: {manifest_path}')
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f'Could not read dataset manifest: {error}') from error

    required = {'schema_version', 'dataset_id', 'source', 'license', 'approval_record', 'approved_for_training', 'class_ids'}
    if not isinstance(manifest, dict) or not required.issubset(manifest):
        raise ValueError('Dataset manifest is missing required provenance fields.')
    if manifest.get('schema_version') != 1 or manifest.get('approved_for_training') is not True:
        raise ValueError('Dataset manifest is not approved for training.')
    for field in ('dataset_id', 'source', 'license', 'approval_record'):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            raise ValueError(f'Dataset manifest field {field} must be a non-empty string.')
    manifest_class_ids = manifest.get('class_ids')
    if (
        not isinstance(manifest_class_ids, list)
        or not manifest_class_ids
        or not all(isinstance(class_id, str) and class_id.strip() for class_id in manifest_class_ids)
        or len(set(manifest_class_ids)) != len(manifest_class_ids)
    ):
        raise ValueError('Dataset manifest class_ids must be a non-empty, unique list of ids.')
    if manifest.get('source') != dataset_source or manifest.get('license') != dataset_license:
        raise ValueError('Dataset source/license arguments must exactly match the approved manifest.')
    if not set(class_ids).issubset(set(manifest_class_ids)):
        raise ValueError('Dataset manifest does not cover every requested class.')
    return {
        'dataset_id': manifest['dataset_id'],
        'source': manifest['source'],
        'license': manifest['license'],
        'approval_record': manifest['approval_record'],
        'manifest_sha256': sha256_file(manifest_path),
        'class_ids': manifest_class_ids,
    }


def resolve_class_ids(catalog, group, allow_mixed_domains):
    if group == 'all':
        if not allow_mixed_domains:
            raise ValueError(
                'Refusing to mix dermoscopic lesion images and ordinary clinical photos. '
                'Train --group lesion and --group clinical separately, or explicitly pass --allow-mixed-domains after validation.'
            )
        return sorted(catalog)
    return sorted(class_id for class_id, entry in catalog.items() if entry['group'] == group)


def validate_data_directory(data_dir, class_ids, minimum_images):
    expected_ids = set(class_ids)
    unexpected_folders = sorted(
        path.name for path in data_dir.iterdir()
        if path.is_dir() and not path.name.startswith('.') and path.name not in expected_ids
    )
    missing_folders = []
    underrepresented = []
    image_counts = {}
    hashes = {}
    for class_id in class_ids:
        folder = data_dir / class_id
        if not folder.is_dir():
            missing_folders.append(class_id)
            continue
        files = image_files(folder)
        count = len(files)
        image_counts[class_id] = count
        for file_path in files:
            file_hash = sha256_file(file_path)
            hashes.setdefault(file_hash, []).append((class_id, file_path.name))
        if count < minimum_images:
            underrepresented.append(f'{class_id} ({count})')

    problems = []
    if missing_folders:
        problems.append('missing folders: ' + ', '.join(missing_folders))
    if unexpected_folders:
        problems.append('unexpected class folders outside the approved catalog: ' + ', '.join(unexpected_folders))
    if underrepresented:
        problems.append(f'classes below --min-images={minimum_images}: ' + ', '.join(underrepresented))
    duplicates = [entries for entries in hashes.values() if len(entries) > 1]
    if duplicates:
        examples = '; '.join(', '.join(f'{class_id}/{filename}' for class_id, filename in entries[:3]) for entries in duplicates[:5])
        problems.append(f'duplicate image content detected across the training set: {examples}')
    if problems:
        raise ValueError('; '.join(problems))
    return image_counts, {'image_files': sum(image_counts.values()), 'unique_image_hashes': len(hashes)}


def make_model(class_count):
    augmentation = tf.keras.Sequential(
        [
            layers.RandomFlip('horizontal'),
            layers.RandomRotation(0.10),
            layers.RandomZoom(0.10),
            layers.RandomContrast(0.08),
        ],
        name='augmentation',
    )
    base_model = MobileNetV2(input_shape=(*IMAGE_SIZE, 3), include_top=False, weights='imagenet')
    base_model.trainable = False
    inputs = tf.keras.Input(shape=(*IMAGE_SIZE, 3))
    x = augmentation(inputs)
    x = layers.Rescaling(1.0 / 127.5, offset=-1)(x)
    x = base_model(x, training=False)
    x = layers.GlobalAveragePooling2D()(x)
    x = layers.Dropout(0.30)(x)
    outputs = layers.Dense(class_count, activation='softmax', name='screening_scores')(x)
    model = tf.keras.Model(inputs, outputs)
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=3e-4),
        loss='sparse_categorical_crossentropy',
        metrics=['accuracy'],
    )
    return model


def evaluate_model(model, validation_dataset, class_ids):
    true_labels = []
    predicted_labels = []
    for images, labels in validation_dataset:
        probabilities = model(images, training=False).numpy()
        true_labels.extend(labels.numpy().tolist())
        predicted_labels.extend(np.argmax(probabilities, axis=1).tolist())

    class_count = len(class_ids)
    confusion = tf.math.confusion_matrix(true_labels, predicted_labels, num_classes=class_count).numpy()
    accuracy = float(np.mean(np.asarray(true_labels) == np.asarray(predicted_labels))) if true_labels else 0.0
    per_class_metrics = {}
    for index, class_id in enumerate(class_ids):
        true_positive = int(confusion[index, index])
        actual_total = int(confusion[index, :].sum())
        predicted_total = int(confusion[:, index].sum())
        per_class_metrics[class_id] = {
            'support': actual_total,
            'recall': true_positive / actual_total if actual_total else None,
            'precision': true_positive / predicted_total if predicted_total else None,
        }
    return {
        'validation_accuracy': accuracy,
        'confusion_matrix': confusion.tolist(),
        'validation_examples': len(true_labels),
        # This split comes from the training directory and is useful for model
        # development only. It is not the independent clinical evaluation
        # required before a production release.
        'per_class_metrics': per_class_metrics,
    }


def train(args):
    catalog = load_catalog()
    class_ids = resolve_class_ids(catalog, args.group, args.allow_mixed_domains)
    data_dir = Path(args.data_dir).resolve()
    if not data_dir.is_dir():
        raise ValueError(f'Dataset directory does not exist: {data_dir}')

    manifest_path = Path(args.dataset_manifest).resolve() if args.dataset_manifest else data_dir / DATASET_MANIFEST_NAME
    dataset_manifest = load_dataset_manifest(manifest_path, args.dataset_source, args.dataset_license, class_ids)
    image_counts, image_integrity = validate_data_directory(data_dir, class_ids, args.min_images)
    class_labels = [catalog[class_id]['label'] for class_id in class_ids]
    print(f'Training {len(class_ids)} classes from {sum(image_counts.values())} images.')

    dataset_arguments = {
        'directory': str(data_dir),
        'labels': 'inferred',
        'label_mode': 'int',
        'class_names': class_ids,
        'validation_split': args.validation_split,
        'seed': args.seed,
        'image_size': IMAGE_SIZE,
        'batch_size': args.batch_size,
    }
    train_dataset = tf.keras.utils.image_dataset_from_directory(subset='training', shuffle=True, **dataset_arguments)
    validation_dataset = tf.keras.utils.image_dataset_from_directory(subset='validation', shuffle=False, **dataset_arguments)

    autotune = tf.data.AUTOTUNE
    train_dataset = train_dataset.prefetch(autotune)
    validation_dataset = validation_dataset.prefetch(autotune)
    total_images = sum(image_counts.values())
    class_weights = {
        index: total_images / (len(class_ids) * image_counts[class_id])
        for index, class_id in enumerate(class_ids)
    }

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output_path.with_name(output_path.stem + '.best.keras')
    model = make_model(len(class_ids))
    callbacks = [
        EarlyStopping(monitor='val_loss', patience=args.patience, restore_best_weights=True),
        ModelCheckpoint(str(checkpoint_path), monitor='val_loss', save_best_only=True),
    ]
    history = model.fit(
        train_dataset,
        validation_data=validation_dataset,
        epochs=args.epochs,
        class_weight=class_weights,
        callbacks=callbacks,
    )
    model.save(output_path)

    evaluation = evaluate_model(model, validation_dataset, class_ids)
    model_version = f'{args.group}-{datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")}'
    model_input_domain = 'dermoscopic' if args.group == 'lesion' else 'clinical' if args.group == 'clinical' else 'multi_domain'
    input_routing = None
    if args.group == 'all':
        input_routing = {
            # The application must ask which acquisition type was used; it
            # must never guess clinical-versus-dermoscopy from the image.
            'requires_user_selected_domain': True,
            'supported_domains': {
                'clinical': [class_id for class_id in class_ids if catalog[class_id]['group'] == 'clinical'],
                'lesion': [class_id for class_id in class_ids if catalog[class_id]['group'] == 'lesion'],
            },
        }
    metadata = {
        'schema_version': 2,
        'model_version': model_version,
        'class_names': class_labels,
        'class_ids': class_ids,
        'image_size': IMAGE_SIZE,
        'group': args.group,
        'mixed_domains_allowed': bool(args.allow_mixed_domains),
        'model_input_domain': model_input_domain,
        'input_routing': input_routing,
        'dataset_manifest': dataset_manifest,
        'image_counts': image_counts,
        'image_integrity': image_integrity,
        'validation_split': args.validation_split,
        'training_completed_at': datetime.now(timezone.utc).isoformat(),
        'abstention_threshold': args.abstention_threshold,
        'margin_threshold': args.margin_threshold,
        'out_of_scope_threshold': args.out_of_scope_threshold,
        'final_metrics': {key: float(values[-1]) for key, values in history.history.items() if values},
        'training_evaluation': evaluation,
        # These fields are intentionally incomplete: a training run is not a
        # clinical release. They must be populated by an independent review process.
        'independent_evaluation': None,
        'independent_evaluation_manifest_sha256': None,
        'calibration': None,
        'deployment_review': {'approved_for_clinical_screening': False},
    }
    metadata['artifact_sha256'] = sha256_file(output_path)
    metadata_path = output_path.with_suffix('.metadata.json')
    evaluation_path = output_path.with_suffix('.evaluation.json')
    independent_evaluation_template_path = output_path.with_suffix('.independent-evaluation.template.json')
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    evaluation_path.write_text(json.dumps(evaluation, ensure_ascii=False, indent=2), encoding='utf-8')
    independent_evaluation_template_path.write_text(
        json.dumps(
            build_evaluation_manifest_template(
                metadata,
                catalog,
                metadata_sha256=sha256_file(metadata_path),
            ),
            ensure_ascii=False,
            indent=2,
        ) + '\n',
        encoding='utf-8',
    )

    print(f'Model saved: {output_path}')
    print(f'Metadata saved: {metadata_path}')
    print(f'Evaluation saved: {evaluation_path}')
    print(f'Independent evaluation template saved: {independent_evaluation_template_path}')
    print('Do not deploy until a clinician reviews the label mapping, held-out metrics, confusion matrix, and intended-use limitations.')


def parse_args():
    parser = argparse.ArgumentParser(description='Train a provenance-tracked multi-class skin-image screening model.')
    parser.add_argument('--data-dir', required=True, help='Directory containing one folder per disease_catalog class id.')
    parser.add_argument('--group', choices=('lesion', 'clinical', 'all'), required=True, help='Catalog group to train.')
    parser.add_argument('--allow-mixed-domains', action='store_true', help='Explicitly allow --group all after clinical validation.')
    parser.add_argument('--dataset-source', required=True, help='Source URL or internal dataset identifier recorded in metadata.')
    parser.add_argument('--dataset-license', required=True, help='License or approved data-use agreement recorded in metadata.')
    parser.add_argument('--dataset-manifest', help='Approved dataset_manifest.json; defaults to <data-dir>/dataset_manifest.json.')
    parser.add_argument('--output', default=str(PROJECT_ROOT / 'models' / 'skin_disease_model.h5'))
    parser.add_argument('--min-images', type=int, default=200, help='Minimum image count required for every selected class.')
    parser.add_argument('--validation-split', type=float, default=0.20)
    parser.add_argument('--epochs', type=int, default=20)
    parser.add_argument('--batch-size', type=int, default=32)
    parser.add_argument('--patience', type=int, default=4)
    parser.add_argument('--seed', type=int, default=20260830)
    parser.add_argument('--abstention-threshold', type=float, default=0.60)
    parser.add_argument('--margin-threshold', type=float, default=0.12)
    parser.add_argument('--out-of-scope-threshold', type=float, default=0.45,
                        help='Low-score screening threshold for a potentially unsupported image; calibrate before deployment.')
    args = parser.parse_args()
    if args.min_images < 2:
        parser.error('--min-images must be at least 2.')
    if not 0 < args.validation_split < 0.5:
        parser.error('--validation-split must be between 0 and 0.5.')
    if not 0 <= args.abstention_threshold <= 1 or not 0 <= args.margin_threshold <= 1 or not 0 <= args.out_of_scope_threshold <= 1:
        parser.error('abstention, margin, and out-of-scope thresholds must be between 0 and 1.')
    if args.out_of_scope_threshold > args.abstention_threshold:
        parser.error('--out-of-scope-threshold cannot be greater than --abstention-threshold.')
    return args


if __name__ == '__main__':
    try:
        train(parse_args())
    except ValueError as error:
        raise SystemExit(f'Error: {error}')
