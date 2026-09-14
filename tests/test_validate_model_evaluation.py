import copy
import json
import tempfile
import unittest
from pathlib import Path

import validate_model_evaluation as evidence


def provenance(dataset_id):
    return {
        'dataset_id': dataset_id,
        'source': 'https://example.test/approved-source',
        'license': 'Approved DUA',
        'approval_record': 'IRB-2026-50',
        'manifest_sha256': '1' * 64,
    }


def metric():
    return {
        'support': 3,
        'recall': 0.5,
        'precision': 0.6,
        'recall_ci_95': {'lower': 0.2, 'upper': 0.8},
    }


class TestIndependentEvaluationEvidence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = evidence.load_catalog(evidence.DEFAULT_CATALOG)
        cls.class_ids = list(cls.catalog)
        cls.class_names = [cls.catalog[class_id]['label'] for class_id in cls.class_ids]

    def valid_metadata(self, artifact_sha256='a' * 64):
        return {
            'model_version': 'candidate-50-2026',
            'class_ids': list(self.class_ids),
            'class_names': list(self.class_names),
            'dataset_manifest': provenance('approved-training-set'),
            'model_input_domain': 'multi_domain',
            'artifact_sha256': artifact_sha256,
            'abstention_threshold': 0.60,
            'margin_threshold': 0.12,
            'out_of_scope_threshold': 0.45,
        }

    def valid_evaluation(self, metadata, metadata_sha256='b' * 64):
        clinical_ids = [class_id for class_id in self.class_ids if self.catalog[class_id]['group'] == 'clinical']
        dermoscopic_ids = [class_id for class_id in self.class_ids if self.catalog[class_id]['group'] == 'lesion']
        return {
            'schema_version': 1,
            'evaluation_id': 'independent-eval-2026-01',
            'evaluation_date': '2026-09-03T12:00:00+07:00',
            'model': {
                'model_version': metadata['model_version'],
                'artifact_sha256': metadata['artifact_sha256'],
                'metadata_sha256': metadata_sha256,
                'class_ids': list(self.class_ids),
                'class_names': list(self.class_names),
            },
            'evaluation_dataset': provenance('approved-independent-evaluation-set'),
            'independence': {
                'patient_or_lesion_disjoint': True,
                'split_unit': 'patient_and_lesion',
                'split_manifest_sha256': '2' * 64,
                'reviewed_by': 'Independent data reviewer',
                'reviewed_at': '2026-09-03T12:00:00+07:00',
                'review_reference': 'SPLIT-AUDIT-001',
            },
            'overall_metrics': {'image_count': 150, 'accuracy': 0.5},
            'per_class_metrics': {class_id: metric() for class_id in self.class_ids},
            'by_input_domain': {
                'clinical': {
                    'image_count': 132,
                    'class_ids': clinical_ids,
                    'per_class_metrics': {class_id: metric() for class_id in clinical_ids},
                },
                'dermoscopic': {
                    'image_count': 18,
                    'class_ids': dermoscopic_ids,
                    'per_class_metrics': {class_id: metric() for class_id in dermoscopic_ids},
                },
            },
            'calibration_and_ood': {
                'method': 'temperature scaling',
                'validated_at': '2026-09-03T12:00:00+07:00',
                'calibration_dataset': provenance('approved-calibration-set'),
                'expected_calibration_error': 0.1,
                'thresholds': {
                    'abstention_threshold': metadata['abstention_threshold'],
                    'margin_threshold': metadata['margin_threshold'],
                    'out_of_scope_threshold': metadata['out_of_scope_threshold'],
                },
                'ood_evaluation': {
                    'dataset': provenance('approved-ood-set'),
                    'image_count': 25,
                    'definition': 'Conditions and non-skin images outside the intended use.',
                    'false_accept_rate': 0.1,
                    'false_accept_rate_ci_95': {'lower': 0.02, 'upper': 0.25},
                },
            },
            'release_review': {
                'intended_use': 'Image-based screening support within the reviewed protocol.',
                'reviewed_by': 'Responsible clinical reviewer',
                'reviewed_at': '2026-09-03T12:00:00+07:00',
                'approval_reference': 'RELEASE-REVIEW-001',
                'approved_for_clinical_screening': True,
            },
        }

    def test_complete_evidence_is_consistent_without_claiming_deployment(self):
        metadata = self.valid_metadata()
        evaluation = self.valid_evaluation(metadata)

        report = evidence.validate_evaluation_evidence(
            metadata,
            evaluation,
            self.catalog,
            metadata_sha256='b' * 64,
            artifact_sha256='a' * 64,
        )

        self.assertTrue(report['evidence_format_valid'])
        self.assertTrue(report['human_review_required'])
        self.assertTrue(report['not_a_clinical_validity_or_deployment_approval'])
        self.assertEqual(report['problems'], [])

    def test_rejects_model_order_and_calibration_threshold_mismatch(self):
        metadata = self.valid_metadata()
        evaluation = self.valid_evaluation(metadata)
        evaluation['model']['class_ids'].reverse()
        evaluation['model']['class_names'].reverse()
        evaluation['calibration_and_ood']['thresholds']['margin_threshold'] = 0.30

        report = evidence.validate_evaluation_evidence(
            metadata,
            evaluation,
            self.catalog,
            metadata_sha256='b' * 64,
            artifact_sha256='a' * 64,
        )

        self.assertFalse(report['evidence_format_valid'])
        self.assertIn('evaluation.model.class_ids order does not match the model metadata.', report['problems'])
        self.assertIn('evaluation.calibration_and_ood.thresholds.margin_threshold must match metadata.', report['problems'])

    def test_path_validation_binds_evidence_to_actual_artifact_and_metadata_hash(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            model_path = root / 'candidate.h5'
            metadata_path = root / 'candidate.metadata.json'
            evaluation_path = root / 'candidate.independent-evaluation.json'
            model_path.write_bytes(b'candidate-artifact')
            artifact_sha256 = evidence.sha256_file(model_path)
            metadata = self.valid_metadata(artifact_sha256)
            metadata_path.write_text(json.dumps(metadata), encoding='utf-8')
            evaluation = self.valid_evaluation(metadata, evidence.sha256_file(metadata_path))
            evaluation_path.write_text(json.dumps(evaluation), encoding='utf-8')

            report = evidence.validate_paths(metadata_path, evaluation_path, model_path)

        self.assertTrue(report['evidence_format_valid'])
        self.assertEqual(report['artifact_sha256'], artifact_sha256)

    def test_generated_template_is_bound_to_all_fifty_model_outputs_but_not_approved(self):
        template = evidence.build_evaluation_manifest_template(
            self.valid_metadata(), self.catalog, metadata_sha256='b' * 64
        )

        self.assertEqual(template['model']['class_ids'], self.class_ids)
        self.assertEqual(set(template['per_class_metrics']), set(self.class_ids))
        self.assertFalse(template['independence']['patient_or_lesion_disjoint'])
        self.assertFalse(template['release_review']['approved_for_clinical_screening'])


if __name__ == '__main__':
    unittest.main()
