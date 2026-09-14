import csv
import json
import tempfile
import unittest
from pathlib import Path

from import_scin_metadata import create_audit


PROJECT_ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = PROJECT_ROOT / 'dataset' / 'multiclass' / 'scin_source_label_policy.json'
CATALOG_PATH = PROJECT_ROOT / 'disease_catalog.json'


class ScinMetadataImportTests(unittest.TestCase):
    def write_csv(self, path, fields, rows):
        with path.open('w', encoding='utf-8', newline='') as output_file:
            writer = csv.DictWriter(output_file, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)

    def test_selects_only_a_gradable_unique_mapped_primary_label(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cases = root / 'cases.csv'
            labels = root / 'labels.csv'
            self.write_csv(cases, ['case_id', 'image_1_path', 'image_2_path', 'image_3_path'], [
                {'case_id': 'selected', 'image_1_path': 'dataset/images/a.png', 'image_2_path': '', 'image_3_path': ''},
                {'case_id': 'tie', 'image_1_path': 'dataset/images/b.png', 'image_2_path': '', 'image_3_path': ''},
                {'case_id': 'broad', 'image_1_path': 'dataset/images/c.png', 'image_2_path': '', 'image_3_path': ''},
            ])
            label_fields = [
                'case_id', 'dermatologist_gradable_for_skin_condition_1',
                'weighted_skin_condition_label',
            ]
            self.write_csv(labels, label_fields, [
                {
                    'case_id': 'selected',
                    'dermatologist_gradable_for_skin_condition_1': 'DEFAULT_YES_IMAGE_QUALITY_SUFFICIENT',
                    'weighted_skin_condition_label': "{'Psoriasis': 0.75, 'Eczema': 0.25}",
                },
                {
                    'case_id': 'tie',
                    'dermatologist_gradable_for_skin_condition_1': 'DEFAULT_YES_IMAGE_QUALITY_SUFFICIENT',
                    'weighted_skin_condition_label': "{'Psoriasis': 0.5, 'Eczema': 0.5}",
                },
                {
                    'case_id': 'broad',
                    'dermatologist_gradable_for_skin_condition_1': 'DEFAULT_YES_IMAGE_QUALITY_SUFFICIENT',
                    'weighted_skin_condition_label': "{'Tinea': 1.0}",
                },
            ])
            records, report = create_audit(cases, labels, POLICY_PATH, CATALOG_PATH)

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['case_id'], 'selected')
        self.assertEqual(records[0]['target_id'], 'psoriasis')
        self.assertEqual(report['candidate_cases_by_target']['psoriasis'], 1)
        self.assertEqual(report['skipped_cases_by_reason']['source_label_tie'], 1)
        self.assertEqual(report['skipped_cases_by_reason']['primary_label_not_mapped'], 1)
        self.assertFalse(report['selection']['allows_model_activation'])

    def test_policy_remains_metadata_only_and_references_only_catalog_targets(self):
        policy = json.loads(POLICY_PATH.read_text(encoding='utf-8'))
        catalog = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
        target_ids = {item['id'] for item in catalog['classes']}

        self.assertEqual(policy['status'], 'research_metadata_mapping_only_not_model_activation')
        self.assertFalse(policy['selection']['allows_image_download'])
        self.assertFalse(policy['selection']['allows_model_activation'])
        self.assertTrue({item['target_id'] for item in policy['source_label_mappings'].values()} <= target_ids)
        self.assertFalse(policy['source_label_mappings']['Photodermatitis']['research_candidate'])


if __name__ == '__main__':
    unittest.main()
