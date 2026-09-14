import json
import hashlib
import numpy as np
import tensorflow as tf
from tensorflow.keras.preprocessing import image
from pathlib import Path
from PIL import Image

# รายชื่อโรค (ยึดตาม Dataset HAM10000)
CLASS_NAMES = ['Actinic keratoses', 'Basal cell carcinoma', 'Benign keratosis', 'Dermatofibroma', 'Melanoma', 'Vascular lesions']
MODEL_PATH = Path(__file__).resolve().parent / 'models' / 'skin_disease_model.h5'
MODEL_METADATA_PATH = MODEL_PATH.with_suffix('.metadata.json')
DISEASE_CATALOG_PATH = Path(__file__).resolve().parent / 'disease_catalog.json'

def load_model(model_path=None):
    """Load the packaged model independently of the process working directory."""
    resolved_path = Path(model_path) if model_path is not None else MODEL_PATH
    if resolved_path.is_file():
        return tf.keras.models.load_model(str(resolved_path))
    return None


def load_model_metadata(metadata_path=None):
    """Read the label order produced by training, with a safe legacy fallback."""
    resolved_path = Path(metadata_path) if metadata_path is not None else MODEL_METADATA_PATH
    default_metadata = {
        'schema_version': 0,
        'metadata_present': False,
        'model_version': 'legacy-6-class',
        'class_names': CLASS_NAMES,
        'class_ids': None,
        'abstention_threshold': 0.60,
        'margin_threshold': 0.12,
        # This threshold is only a screening safeguard.  It must be calibrated
        # with in-scope and out-of-scope images before a newly trained model is
        # deployed.
        'out_of_scope_threshold': 0.45,
        'artifact_sha256': None,
        'model_input_domain': None,
        'input_routing': None,
        'dataset_manifest': None,
        'independent_evaluation': None,
        # A release candidate is not allowed to self-attest inside metadata.
        # Production must bind it to a separately reviewed, immutable evidence
        # manifest whose digest is recorded here.
        'independent_evaluation_manifest_sha256': None,
        'calibration': None,
        'deployment_review': None,
    }
    if not resolved_path.is_file():
        return default_metadata

    try:
        metadata = json.loads(resolved_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return default_metadata

    class_names = metadata.get('class_names')
    if not isinstance(class_names, list) or not class_names or not all(isinstance(name, str) and name.strip() for name in class_names):
        return default_metadata

    try:
        return {
            'schema_version': int(metadata.get('schema_version', 0)),
            'metadata_present': True,
            'model_version': str(metadata.get('model_version') or resolved_path.stem),
            'class_names': class_names,
            'class_ids': metadata.get('class_ids'),
            'abstention_threshold': float(metadata.get('abstention_threshold', default_metadata['abstention_threshold'])),
            'margin_threshold': float(metadata.get('margin_threshold', default_metadata['margin_threshold'])),
            'out_of_scope_threshold': float(metadata.get('out_of_scope_threshold', default_metadata['out_of_scope_threshold'])),
            'artifact_sha256': metadata.get('artifact_sha256'),
            'model_input_domain': metadata.get('model_input_domain'),
            'input_routing': metadata.get('input_routing'),
            'dataset_manifest': metadata.get('dataset_manifest'),
            'independent_evaluation': metadata.get('independent_evaluation'),
            'independent_evaluation_manifest_sha256': metadata.get('independent_evaluation_manifest_sha256'),
            'calibration': metadata.get('calibration'),
            'deployment_review': metadata.get('deployment_review'),
        }
    except (TypeError, ValueError):
        return default_metadata


def sha256_file(path):
    """Return an artifact digest without loading all of a large model into memory."""
    digest = hashlib.sha256()
    with Path(path).open('rb') as artifact:
        for block in iter(lambda: artifact.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _catalog_contract_problems(metadata, expected_catalog):
    """Verify that a release artifact covers exactly the configured disease catalog."""
    if not expected_catalog:
        return []

    catalog_by_id = {item.get('id'): item for item in expected_catalog.values()}
    expected_ids = set(catalog_by_id)
    class_ids = metadata.get('class_ids')
    class_names = metadata.get('class_names') or []
    problems = []

    if not isinstance(class_ids, list) or len(class_ids) != len(class_names):
        return ['ไม่มี class_ids ที่จับคู่กับ output ของโมเดล']
    if not all(isinstance(class_id, str) and class_id for class_id in class_ids):
        return ['class_ids ของโมเดลมีรูปแบบไม่ถูกต้อง']
    if len(set(class_ids)) != len(class_ids):
        return ['class_ids ของโมเดลซ้ำกัน']
    if set(class_ids) != expected_ids:
        missing = len(expected_ids - set(class_ids))
        extra = len(set(class_ids) - expected_ids)
        problems.append(
            f'โมเดลครอบคลุมโรคไม่ครบตาม catalog 50 โรค (ขาด {missing} โรค, เกิน/ไม่รู้จัก {extra} โรค)'
        )
        return problems

    for class_id, class_name in zip(class_ids, class_names):
        expected_label = catalog_by_id[class_id].get('label')
        if class_name != expected_label:
            problems.append(f'class_ids และลำดับ output ไม่ตรงกับ catalog ที่ {class_id}')
            break
    return problems


def _model_output_class_count(model):
    """Read a concrete Keras output width when it is exposed by the artifact."""
    output_shape = getattr(model, 'output_shape', None)
    if isinstance(output_shape, tuple) and output_shape:
        output_width = output_shape[-1]
        if isinstance(output_width, int) and not isinstance(output_width, bool):
            return output_width
    return None


def _multi_domain_routing_problems(metadata, expected_catalog):
    """Require an explicit user-selected image domain for a multi-domain artifact."""
    if not expected_catalog:
        return []

    groups = {}
    for item in expected_catalog.values():
        groups.setdefault(item.get('group'), set()).add(item.get('id'))
    if len(groups) < 2:
        return []

    if metadata.get('model_input_domain') != 'multi_domain':
        return ['โมเดล 50 โรคต้องระบุการรองรับภาพ clinical และ dermoscopic แยกกัน']

    routing = metadata.get('input_routing')
    if not isinstance(routing, dict) or not routing.get('requires_user_selected_domain'):
        return ['โมเดลหลายชนิดภาพต้องบังคับให้ผู้ใช้เลือกชนิดภาพก่อนคัดกรอง']
    supported_domains = routing.get('supported_domains')
    if not isinstance(supported_domains, dict):
        return ['ไม่มีการจับคู่ชนิดภาพกับโรคที่โมเดลรองรับ']
    for domain, expected_ids in groups.items():
        routed_ids = supported_domains.get(domain)
        if not isinstance(routed_ids, list) or set(routed_ids) != expected_ids:
            return [f'การจับคู่ชนิดภาพ {domain} กับโรคในโมเดลไม่ครบถ้วน']
    return []


def validate_release_evidence_paths(metadata_path, evaluation_manifest_path, model_path, catalog_path=DISEASE_CATALOG_PATH):
    """Validate a model's independent evidence package without activating it.

    The full validator deliberately lives in its own module so training and
    offline review can use it without loading TensorFlow.  Import lazily here
    to keep normal prediction imports lightweight and avoid a module cycle.
    """
    from validate_model_evaluation import validate_paths
    return validate_paths(
        Path(metadata_path),
        Path(evaluation_manifest_path),
        Path(model_path),
        Path(catalog_path),
    )


def _independent_evidence_problems(metadata, artifact_path, expected_catalog, metadata_path, evaluation_manifest_path):
    """Require integrity-bound review evidence for a catalog release.

    A field copied into model metadata is not sufficient evidence: it can be
    edited independently of the reviewed evaluation.  When an application is
    configured against a disease catalog, bind the external evidence file to
    the exact metadata and model artifact before the production gate can pass.
    """
    if not expected_catalog:
        return []
    if not metadata_path or not Path(metadata_path).is_file():
        return ['ไม่พบไฟล์ metadata สำหรับตรวจหลักฐานการประเมินอิสระ']
    if not evaluation_manifest_path or not Path(evaluation_manifest_path).is_file():
        return ['ไม่มีไฟล์หลักฐานการประเมินอิสระที่ผูกกับโมเดล release นี้']

    expected_digest = metadata.get('independent_evaluation_manifest_sha256')
    if not isinstance(expected_digest, str) or not expected_digest:
        return ['metadata ไม่มีรหัสตรวจสอบไฟล์หลักฐานการประเมินอิสระ']
    try:
        actual_digest = sha256_file(evaluation_manifest_path)
    except OSError:
        return ['ไม่สามารถอ่านไฟล์หลักฐานการประเมินอิสระ']
    if actual_digest.casefold() != expected_digest.casefold():
        # This comparison is separate from validation below: it detects a
        # substituted evidence file even if it is structurally valid.
        return ['รหัสตรวจสอบไฟล์หลักฐานการประเมินอิสระไม่ตรงกับ metadata']

    try:
        report = validate_release_evidence_paths(
            metadata_path,
            evaluation_manifest_path,
            artifact_path,
        )
    except (OSError, ValueError, json.JSONDecodeError):
        return ['ไม่สามารถตรวจสอบหลักฐานการประเมินอิสระของโมเดล release นี้']
    if not report.get('evidence_format_valid'):
        return ['ไฟล์หลักฐานการประเมินอิสระไม่ผ่านการตรวจความสอดคล้อง']
    return []


def assess_deployment_readiness(
    model,
    metadata,
    model_path=None,
    expected_catalog=None,
    metadata_path=None,
    evaluation_manifest_path=None,
):
    """Require reviewable evidence before a model can screen production health data.

    This gate deliberately does not infer medical safety from a model file or a
    top-1 score.  Human review and an independent evaluation must be recorded
    in the model metadata by the release process.
    """
    problems = []
    if model is None:
        problems.append('ไม่พบไฟล์โมเดล')
    if not metadata.get('metadata_present') or metadata.get('schema_version', 0) < 2:
        problems.append('ไม่มี metadata เวอร์ชันที่ตรวจสอบย้อนกลับได้')

    artifact_path = Path(model_path) if model_path is not None else MODEL_PATH
    expected_hash = metadata.get('artifact_sha256')
    if not expected_hash:
        problems.append('ไม่มีรหัสตรวจสอบไฟล์โมเดล')
    elif artifact_path.is_file() and sha256_file(artifact_path) != expected_hash:
        problems.append('รหัสตรวจสอบไฟล์โมเดลไม่ตรงกับ metadata')

    if metadata.get('model_input_domain') not in {'clinical', 'dermoscopic', 'multi_domain'}:
        problems.append('ไม่ได้ระบุชนิดภาพที่โมเดลรองรับ')
    if not isinstance(metadata.get('dataset_manifest'), dict):
        problems.append('ไม่มีข้อมูลที่มาชุดข้อมูล')

    independent_evaluation = metadata.get('independent_evaluation')
    required_evaluation_fields = {
        'dataset_id', 'evaluation_date', 'image_count',
        'patient_or_lesion_disjoint', 'per_class_metrics',
    }
    if not isinstance(independent_evaluation, dict) or not required_evaluation_fields.issubset(independent_evaluation):
        problems.append('ไม่มีผลประเมินอิสระครบถ้วน')
    elif not independent_evaluation.get('patient_or_lesion_disjoint'):
        problems.append('ผลประเมินอิสระไม่ได้แยกผู้ป่วย/รอยโรคจากข้อมูลฝึก')

    calibration = metadata.get('calibration')
    if not isinstance(calibration, dict) or not calibration.get('validated_on'):
        problems.append('ไม่มีหลักฐานการปรับเทียบคะแนนและภาพนอกขอบเขต')

    review = metadata.get('deployment_review')
    required_review_fields = {'approved_by', 'approved_at', 'approval_reference'}
    if not isinstance(review, dict) or not review.get('approved_for_clinical_screening') or not required_review_fields.issubset(review):
        problems.append('ยังไม่มีการอนุมัติ intended use โดยผู้รับผิดชอบทางคลินิก')

    problems.extend(_catalog_contract_problems(metadata, expected_catalog))
    problems.extend(_multi_domain_routing_problems(metadata, expected_catalog))
    problems.extend(
        _independent_evidence_problems(
            metadata,
            artifact_path,
            expected_catalog,
            metadata_path,
            evaluation_manifest_path,
        )
    )
    output_class_count = _model_output_class_count(model)
    if output_class_count is not None and output_class_count != len(metadata.get('class_names') or []):
        problems.append('จำนวน output จริงของโมเดลไม่ตรงกับรายชื่อโรคใน metadata')

    return {'approved': not problems, 'problems': problems}


def load_disease_catalog():
    """Return display metadata without activating labels that the model does not contain."""
    try:
        catalog = json.loads(DISEASE_CATALOG_PATH.read_text(encoding='utf-8'))
        classes = catalog.get('classes', [])
    except (OSError, json.JSONDecodeError):
        classes = []
    return {
        item['label'].casefold(): item
        for item in classes
        if isinstance(item, dict) and isinstance(item.get('label'), str)
    }


def display_name_for_label(label):
    item = load_disease_catalog().get(label.casefold())
    return item.get('name_th', label) if item else label


def _model_input_size(model):
    """Return the image height and width required by a Keras image model."""
    input_shape = getattr(model, 'input_shape', None)
    if isinstance(input_shape, tuple) and len(input_shape) == 4:
        height, width = input_shape[1], input_shape[2]
        if isinstance(height, int) and isinstance(width, int) and height > 0 and width > 0:
            return height, width
    return 224, 224


def _load_model_image_array(img_path, model):
    height, width = _model_input_size(model)
    img = image.load_img(img_path, target_size=(height, width), color_mode='rgb')
    img_array = image.img_to_array(img)
    return np.expand_dims(img_array, axis=0).astype('float32') / 255.0


def _last_spatial_layer(model):
    """Find the final rank-4 feature layer required by Grad-CAM."""
    for layer in reversed(getattr(model, 'layers', [])):
        output = getattr(layer, 'output', None)
        output_shape = getattr(output, 'shape', None)
        try:
            if output_shape is not None and len(output_shape) == 4:
                return layer
        except TypeError:
            continue
    return None


def _gradcam_color_map(heatmap):
    """Render a red-yellow attention map without a plotting dependency."""
    intensity = np.clip(heatmap, 0.0, 1.0)
    red = np.clip(1.8 * intensity, 0.0, 1.0)
    green = np.clip(1.8 * intensity - 0.35, 0.0, 1.0)
    blue = np.clip(0.55 - 1.2 * intensity, 0.0, 1.0)
    return np.stack((red, green, blue), axis=-1)


def generate_gradcam_overlay(img_path, model, class_index, output_path, alpha=0.46, max_dimension=1280):
    """Save a private Grad-CAM overlay for one model output class.

    The image explains model attention only.  It is not a lesion outline,
    segmentation mask, confidence calibration, or clinical explanation.
    Returns metadata for a successful overlay and ``None`` when the supplied
    model cannot produce a spatial Grad-CAM map.
    """
    if model is None or isinstance(class_index, bool):
        return None
    try:
        target_index = int(class_index)
    except (TypeError, ValueError):
        return None

    spatial_layer = _last_spatial_layer(model)
    if spatial_layer is None:
        return None

    image_array = _load_model_image_array(img_path, model)
    try:
        grad_model = tf.keras.Model(model.inputs, [spatial_layer.output, model.output])
        with tf.GradientTape() as tape:
            convolution_outputs, predictions = grad_model([image_array], training=False)
            class_count = predictions.shape[-1]
            if class_count is None or target_index < 0 or target_index >= int(class_count):
                return None
            class_score = predictions[:, target_index]
        gradients = tape.gradient(class_score, convolution_outputs)
    except (AttributeError, TypeError, ValueError, tf.errors.OpError) as error:
        raise RuntimeError('Grad-CAM could not evaluate this model architecture.') from error

    if gradients is None:
        raise RuntimeError('Grad-CAM gradients were unavailable for this model.')
    pooled_gradients = tf.reduce_mean(gradients, axis=(0, 1, 2))
    heatmap = tf.reduce_sum(convolution_outputs[0] * pooled_gradients[tf.newaxis, tf.newaxis, :], axis=-1)
    heatmap = tf.maximum(heatmap, 0)
    maximum = float(tf.reduce_max(heatmap).numpy())
    if not np.isfinite(maximum) or maximum <= np.finfo('float32').eps:
        raise RuntimeError('Grad-CAM attention map did not contain a positive signal.')
    heatmap = (heatmap / maximum).numpy()

    with Image.open(img_path) as source_image:
        display_image = source_image.convert('RGB')
    display_image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
    heatmap_image = Image.fromarray(np.uint8(np.clip(heatmap, 0, 1) * 255), mode='L')
    heatmap_image = heatmap_image.resize(display_image.size, Image.Resampling.BILINEAR)
    heatmap_array = np.asarray(heatmap_image, dtype='float32') / 255.0
    color_overlay = np.uint8(_gradcam_color_map(heatmap_array) * 255)
    transparency = np.uint8(np.power(heatmap_array, 0.75) * min(max(float(alpha), 0.0), 1.0) * 255)
    overlay = Image.fromarray(np.dstack((color_overlay, transparency)), mode='RGBA')
    rendered = Image.alpha_composite(display_image.convert('RGBA'), overlay).convert('RGB')

    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    rendered.save(destination, format='PNG', optimize=True)
    return {
        'layer_name': spatial_layer.name,
        'width': rendered.width,
        'height': rendered.height,
    }


def predict_image_scores(img_path, model, class_names=None, eligible_class_names=None):
    """Return ranked model scores. This does not turn scores into a diagnosis."""
    if model is None:
        raise ValueError('Model not found.')

    active_class_names = class_names or CLASS_NAMES
    if not active_class_names:
        raise ValueError('No model classes are configured.')

    # Convert all accepted formats to RGB so the input shape is predictable.
    img_array = _load_model_image_array(img_path, model)

    # ทำนายผล
    predictions = np.asarray(model.predict(img_array, verbose=0))
    if predictions.ndim != 2 or predictions.shape[0] != 1 or predictions.shape[1] != len(active_class_names):
        raise ValueError('Model returned an unexpected prediction shape.')

    scores = predictions[0]
    if not np.isfinite(scores).all():
        raise ValueError('Model returned invalid prediction values.')
    if (scores < 0).any() or (scores > 1).any() or not np.isclose(scores.sum(), 1.0, atol=1e-3):
        raise ValueError('Model returned invalid probability values.')

    if eligible_class_names is None:
        eligible_indices = np.arange(len(active_class_names))
    else:
        requested_labels = {str(label).casefold() for label in eligible_class_names}
        eligible_indices = np.asarray(
            [index for index, label in enumerate(active_class_names) if label.casefold() in requested_labels],
            dtype=int,
        )
        if not len(eligible_indices):
            raise ValueError('No model classes are eligible for the selected image domain.')

    ranked_indices = eligible_indices[np.argsort(scores[eligible_indices])[::-1]]
    ranked_predictions = [
        {
            'label': active_class_names[int(index)],
            'confidence': float(scores[int(index)]) * 100,
        }
        for index in ranked_indices
    ]
    top_confidence = ranked_predictions[0]['confidence']
    second_confidence = ranked_predictions[1]['confidence'] if len(ranked_predictions) > 1 else 0.0

    return {
        'label': ranked_predictions[0]['label'],
        'class_index': int(ranked_indices[0]),
        'confidence': top_confidence,
        'margin': top_confidence - second_confidence,
        'ranked_predictions': ranked_predictions,
    }


def predict_image(img_path, model, class_names=None):
    """Compatibility wrapper returning the highest model score only."""
    if model is None:
        return "Model not found (Please train first)", 0.0
    prediction = predict_image_scores(img_path, model, class_names=class_names)
    return prediction['label'], prediction['confidence']
