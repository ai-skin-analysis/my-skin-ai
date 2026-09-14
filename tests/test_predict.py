import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path
import hashlib
import json
import tempfile
import numpy as np

import predict

class TestPredictModule(unittest.TestCase):
    """Unit tests for predict.py module covering positive, negative, and edge cases."""

    def test_class_names_constant(self):
        """Positive Case: Verify CLASS_NAMES contains the expected classes."""
        expected_classes = [
            'Actinic keratoses', 'Basal cell carcinoma', 'Benign keratosis',
            'Dermatofibroma', 'Melanoma', 'Vascular lesions'
        ]
        self.assertEqual(predict.CLASS_NAMES, expected_classes)
        self.assertEqual(len(predict.CLASS_NAMES), 6)

    def test_target_catalog_contains_50_unique_training_labels(self):
        catalog = predict.load_disease_catalog()
        self.assertEqual(len(catalog), 50)
        self.assertIn('tinea pedis', catalog)
        self.assertIn('squamous cell carcinoma', catalog)
        self.assertTrue(all(item['name_en'] == item['label'] for item in catalog.values()))
        self.assertTrue(all(item['legacy_model'] is False for item in catalog.values()))

    @patch('predict.Path.is_file')
    @patch('predict.tf.keras.models.load_model')
    def test_load_model_success(self, mock_tf_load, mock_is_file):
        """Positive Case: load_model returns loaded model when file exists."""
        mock_is_file.return_value = True
        mock_model = MagicMock()
        mock_tf_load.return_value = mock_model

        model = predict.load_model('models/skin_disease_model.h5')
        mock_is_file.assert_called_once()
        mock_tf_load.assert_called_once_with(str(Path('models/skin_disease_model.h5')))
        self.assertEqual(model, mock_model)

    @patch('predict.Path.is_file')
    def test_load_model_not_found(self, mock_is_file):
        """Negative Case: load_model returns None when model file does not exist."""
        mock_is_file.return_value = False
        model = predict.load_model('models/skin_disease_model.h5')
        mock_is_file.assert_called_once()
        self.assertIsNone(model)

    def test_predict_image_model_is_none(self):
        """Negative Case: predict_image returns error message when model is None."""
        class_name, confidence = predict.predict_image('dummy_path.jpg', None)
        self.assertEqual(class_name, "Model not found (Please train first)")
        self.assertEqual(confidence, 0.0)

    def test_metadata_without_file_keeps_legacy_model_contract(self):
        metadata = predict.load_model_metadata('missing-metadata.json')
        self.assertEqual(metadata['class_names'], predict.CLASS_NAMES)
        self.assertEqual(metadata['model_version'], 'legacy-6-class')
        self.assertEqual(metadata['out_of_scope_threshold'], 0.45)
        readiness = predict.assess_deployment_readiness(object(), metadata, 'missing-model.h5')
        self.assertFalse(readiness['approved'])
        self.assertIn('ไม่มี metadata เวอร์ชันที่ตรวจสอบย้อนกลับได้', readiness['problems'])

    def test_complete_reviewed_metadata_passes_the_deployment_gate(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            model_path = Path(temporary_directory) / 'reviewed-model.h5'
            model_path.write_bytes(b'approved-artifact')
            metadata = {
                'metadata_present': True,
                'schema_version': 2,
                'artifact_sha256': hashlib.sha256(b'approved-artifact').hexdigest(),
                'model_input_domain': 'clinical',
                'dataset_manifest': {'dataset_id': 'approved-set'},
                'independent_evaluation': {
                    'dataset_id': 'held-out-set',
                    'evaluation_date': '2026-08-30',
                    'image_count': 1000,
                    'patient_or_lesion_disjoint': True,
                    'per_class_metrics': {'acne_vulgaris': {'recall': 0.8}},
                },
                'calibration': {'validated_on': 'held-out-set'},
                'deployment_review': {
                    'approved_for_clinical_screening': True,
                    'approved_by': 'clinical reviewer',
                    'approved_at': '2026-08-30',
                    'approval_reference': 'review-123',
                },
            }
            self.assertTrue(predict.assess_deployment_readiness(object(), metadata, model_path)['approved'])

    def test_fifty_class_release_requires_exact_catalog_and_image_routing(self):
        catalog = predict.load_disease_catalog()
        catalog_entries = {item['id']: item for item in catalog.values()}
        class_ids = list(catalog_entries)
        class_names = [catalog_entries[class_id]['label'] for class_id in class_ids]
        routing = {
            'requires_user_selected_domain': True,
            'supported_domains': {
                'clinical': [class_id for class_id in class_ids if catalog_entries[class_id]['group'] == 'clinical'],
                'lesion': [class_id for class_id in class_ids if catalog_entries[class_id]['group'] == 'lesion'],
            },
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            model_path = Path(temporary_directory) / 'fifty-class-model.h5'
            model_path.write_bytes(b'fifty-class-artifact')
            metadata = {
                'metadata_present': True,
                'schema_version': 2,
                'artifact_sha256': hashlib.sha256(b'fifty-class-artifact').hexdigest(),
                'class_names': class_names,
                'class_ids': class_ids,
                'model_input_domain': 'multi_domain',
                'input_routing': routing,
                'dataset_manifest': {'dataset_id': 'approved-set'},
                'independent_evaluation': {
                    'dataset_id': 'held-out-set',
                    'evaluation_date': '2026-08-30',
                    'image_count': 5000,
                    'patient_or_lesion_disjoint': True,
                    'per_class_metrics': {class_id: {'recall': 0.8} for class_id in class_ids},
                },
                'calibration': {'validated_on': 'held-out-set'},
                'deployment_review': {
                    'approved_for_clinical_screening': True,
                    'approved_by': 'clinical reviewer',
                    'approved_at': '2026-08-30',
                    'approval_reference': 'review-50-class',
                },
            }
            fifty_output_model = type('FiftyOutputModel', (), {'output_shape': (None, 50)})()
            # A 50-class model must also carry a separately reviewed evidence
            # package.  Fields copied into its metadata alone cannot activate it.
            readiness = predict.assess_deployment_readiness(
                fifty_output_model, metadata, model_path, expected_catalog=catalog
            )
            self.assertFalse(readiness['approved'])
            self.assertIn('ไม่พบไฟล์ metadata สำหรับตรวจหลักฐานการประเมินอิสระ', readiness['problems'])

            metadata['class_ids'] = class_ids[:-1]
            metadata['class_names'] = class_names[:-1]
            readiness = predict.assess_deployment_readiness(
                object(), metadata, model_path, expected_catalog=catalog
            )
            self.assertFalse(readiness['approved'])
            self.assertTrue(any('catalog 50 โรค' in problem for problem in readiness['problems']))

            metadata['class_ids'] = class_ids
            metadata['class_names'] = class_names
            wrong_output_model = type('WrongOutputModel', (), {'output_shape': (None, 6)})()
            readiness = predict.assess_deployment_readiness(
                wrong_output_model, metadata, model_path, expected_catalog=catalog
            )
            self.assertFalse(readiness['approved'])
            self.assertIn('จำนวน output จริงของโมเดลไม่ตรงกับรายชื่อโรคใน metadata', readiness['problems'])

    def test_catalog_release_requires_hash_bound_independent_evidence(self):
        catalog = predict.load_disease_catalog()
        catalog_entries = {item['id']: item for item in catalog.values()}
        class_ids = list(catalog_entries)
        class_names = [catalog_entries[class_id]['label'] for class_id in class_ids]
        routing = {
            'requires_user_selected_domain': True,
            'supported_domains': {
                'clinical': [class_id for class_id in class_ids if catalog_entries[class_id]['group'] == 'clinical'],
                'lesion': [class_id for class_id in class_ids if catalog_entries[class_id]['group'] == 'lesion'],
            },
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            model_path = root / 'fifty-class-model.h5'
            model_path.write_bytes(b'fifty-class-artifact')
            evidence_path = root / 'reviewed-evidence.json'
            evidence_path.write_text('{"review": "independent"}', encoding='utf-8')
            metadata = {
                'metadata_present': True,
                'schema_version': 2,
                'artifact_sha256': hashlib.sha256(b'fifty-class-artifact').hexdigest(),
                'class_names': class_names,
                'class_ids': class_ids,
                'model_input_domain': 'multi_domain',
                'input_routing': routing,
                'dataset_manifest': {'dataset_id': 'approved-set'},
                'independent_evaluation': {
                    'dataset_id': 'held-out-set',
                    'evaluation_date': '2026-08-30',
                    'image_count': 5000,
                    'patient_or_lesion_disjoint': True,
                    'per_class_metrics': {class_id: {'recall': 0.8} for class_id in class_ids},
                },
                'independent_evaluation_manifest_sha256': hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
                'calibration': {'validated_on': 'held-out-set'},
                'deployment_review': {
                    'approved_for_clinical_screening': True,
                    'approved_by': 'clinical reviewer',
                    'approved_at': '2026-08-30',
                    'approval_reference': 'review-50-class',
                },
            }
            metadata_path = root / 'fifty-class-model.metadata.json'
            metadata_path.write_text(json.dumps(metadata), encoding='utf-8')
            fifty_output_model = type('FiftyOutputModel', (), {'output_shape': (None, 50)})()
            with patch('predict.validate_release_evidence_paths', return_value={'evidence_format_valid': True}):
                readiness = predict.assess_deployment_readiness(
                    fifty_output_model,
                    metadata,
                    model_path,
                    expected_catalog=catalog,
                    metadata_path=metadata_path,
                    evaluation_manifest_path=evidence_path,
                )
            self.assertTrue(readiness['approved'])

            evidence_path.write_text('{"review": "substituted"}', encoding='utf-8')
            readiness = predict.assess_deployment_readiness(
                fifty_output_model,
                metadata,
                model_path,
                expected_catalog=catalog,
                metadata_path=metadata_path,
                evaluation_manifest_path=evidence_path,
            )
            self.assertFalse(readiness['approved'])
            self.assertIn('รหัสตรวจสอบไฟล์หลักฐานการประเมินอิสระไม่ตรงกับ metadata', readiness['problems'])

    @patch('predict.image.img_to_array')
    @patch('predict.image.load_img')
    def test_predict_image_success_first_class(self, mock_load_img, mock_img_to_array):
        """Positive Case: predict_image correctly predicts when first class has highest confidence."""
        mock_img = MagicMock()
        mock_load_img.return_value = mock_img
        mock_img_to_array.return_value = np.zeros((224, 224, 3))

        mock_model = MagicMock()
        # Mock prediction probabilities where index 0 is highest (0.95)
        mock_model.predict.return_value = np.array([[0.95, 0.01, 0.01, 0.01, 0.01, 0.01]])

        class_name, confidence = predict.predict_image('test.jpg', mock_model)

        mock_load_img.assert_called_once_with('test.jpg', target_size=(224, 224), color_mode='rgb')
        mock_model.predict.assert_called_once()
        self.assertEqual(class_name, 'Actinic keratoses')
        self.assertAlmostEqual(confidence, 95.0, places=2)

    @patch('predict.image.img_to_array')
    @patch('predict.image.load_img')
    def test_predict_image_success_melanoma(self, mock_load_img, mock_img_to_array):
        """Positive Case: predict_image correctly predicts Melanoma (index 4)."""
        mock_img = MagicMock()
        mock_load_img.return_value = mock_img
        mock_img_to_array.return_value = np.ones((224, 224, 3)) * 255.0

        mock_model = MagicMock()
        # Mock prediction probabilities where index 4 (Melanoma) is highest (0.88)
        mock_model.predict.return_value = np.array([[0.02, 0.02, 0.02, 0.03, 0.88, 0.03]])

        class_name, confidence = predict.predict_image('melanoma_test.jpg', mock_model)

        self.assertEqual(class_name, 'Melanoma')
        self.assertAlmostEqual(confidence, 88.0, places=2)

    @patch('predict.image.img_to_array')
    @patch('predict.image.load_img')
    def test_prediction_can_be_limited_to_declared_image_domain(self, mock_load_img, mock_img_to_array):
        mock_load_img.return_value = MagicMock()
        mock_img_to_array.return_value = np.zeros((224, 224, 3))
        mock_model = MagicMock()
        mock_model.predict.return_value = np.array([[0.05, 0.05, 0.70, 0.05, 0.10, 0.05]])

        result = predict.predict_image_scores(
            'domain.jpg',
            mock_model,
            eligible_class_names=['Melanoma', 'Vascular lesions'],
        )
        self.assertEqual(result['label'], 'Melanoma')
        self.assertEqual([item['label'] for item in result['ranked_predictions']], ['Melanoma', 'Vascular lesions'])

    @patch('predict.image.img_to_array')
    @patch('predict.image.load_img')
    def test_predict_image_edge_case_last_class(self, mock_load_img, mock_img_to_array):
        """Edge Case: Highest confidence is at the last index (Vascular lesions)."""
        mock_load_img.return_value = MagicMock()
        mock_img_to_array.return_value = np.zeros((224, 224, 3))

        mock_model = MagicMock()
        mock_model.predict.return_value = np.array([[0.0, 0.0, 0.0, 0.0, 0.0, 1.0]])

        class_name, confidence = predict.predict_image('vascular.png', mock_model)

        self.assertEqual(class_name, 'Vascular lesions')
        self.assertEqual(confidence, 100.0)

    @patch('predict.image.load_img')
    def test_predict_image_invalid_filepath(self, mock_load_img):
        """Negative/Edge Case: predict_image raises FileNotFoundError if image file loading fails."""
        mock_load_img.side_effect = FileNotFoundError("File not found")
        mock_model = MagicMock()

        with self.assertRaises(FileNotFoundError):
            predict.predict_image('non_existent.jpg', mock_model)

    @patch('predict.image.img_to_array')
    @patch('predict.image.load_img')
    def test_predict_image_rejects_unexpected_model_shape(self, mock_load_img, mock_img_to_array):
        """Negative Case: A model with an incompatible output cannot create a false label."""
        mock_load_img.return_value = MagicMock()
        mock_img_to_array.return_value = np.zeros((224, 224, 3))
        mock_model = MagicMock()
        mock_model.predict.return_value = np.array([[0.9, 0.1]])

        with self.assertRaisesRegex(ValueError, 'unexpected prediction shape'):
            predict.predict_image('invalid-shape.jpg', mock_model)

    @patch('predict.image.img_to_array')
    @patch('predict.image.load_img')
    def test_predict_image_scores_returns_ranked_candidates_and_margin(self, mock_load_img, mock_img_to_array):
        mock_load_img.return_value = MagicMock()
        mock_img_to_array.return_value = np.zeros((224, 224, 3))
        mock_model = MagicMock()
        mock_model.predict.return_value = np.array([[0.41, 0.40, 0.10, 0.04, 0.03, 0.02]])

        result = predict.predict_image_scores('close-call.jpg', mock_model)

        self.assertEqual(result['label'], 'Actinic keratoses')
        self.assertAlmostEqual(result['confidence'], 41.0)
        self.assertAlmostEqual(result['margin'], 1.0)
        self.assertEqual(result['ranked_predictions'][1]['label'], 'Basal cell carcinoma')

    @patch('predict.image.img_to_array')
    @patch('predict.image.load_img')
    def test_predict_image_rejects_non_probability_outputs(self, mock_load_img, mock_img_to_array):
        mock_load_img.return_value = MagicMock()
        mock_img_to_array.return_value = np.zeros((224, 224, 3))
        mock_model = MagicMock()
        mock_model.predict.return_value = np.array([[0.9, 0.9, 0.1, 0.1, 0.1, 0.1]])

        with self.assertRaisesRegex(ValueError, 'invalid probability'):
            predict.predict_image_scores('invalid-values.jpg', mock_model)


if __name__ == '__main__':
    unittest.main()
