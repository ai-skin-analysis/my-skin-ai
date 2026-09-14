import json
from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MAPPING_PATH = PROJECT_ROOT / 'dataset' / 'multiclass' / 'scin_50_target_mapping.draft.json'
CATALOG_PATH = PROJECT_ROOT / 'disease_catalog.json'


class ScinTargetMappingTests(unittest.TestCase):
    def test_draft_preserves_the_proposed_50_condition_roster_without_activation(self):
        mapping = json.loads(MAPPING_PATH.read_text(encoding='utf-8'))

        self.assertEqual(mapping['status'], 'research_metadata_mapping_only_not_for_training_or_model_activation')
        self.assertEqual(len(mapping['classes']), 50)
        self.assertEqual(len({item['id'] for item in mapping['classes']}), 50)
        self.assertTrue(all(item['name_en'] and item['name_th'] for item in mapping['classes']))
        self.assertIn('retrospective differential labels', mapping['source']['label_caveat'])
        self.assertEqual(
            mapping['source']['implemented_policy'],
            'dataset/multiclass/scin_source_label_policy.json',
        )
        catalog = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
        self.assertEqual(
            [item['id'] for item in mapping['classes']],
            [item['id'] for item in catalog['classes']],
        )

    def test_high_risk_and_ambiguous_targets_are_not_marked_as_direct_training_labels(self):
        mapping = json.loads(MAPPING_PATH.read_text(encoding='utf-8'))
        statuses = {item['id']: item['scin_mapping_status'] for item in mapping['classes']}

        self.assertEqual(statuses['melanoma'], 'research_only_high_risk')
        self.assertEqual(statuses['drug_eruption'], 'research_only_high_risk')
        self.assertEqual(statuses['eczema_unspecified'], 'blocked_until_mutually_exclusive_with_atopic_and_contact_dermatitis')
        self.assertEqual(statuses['photodermatoses'], 'blocked_until_subtypes_and_exposure_context_are_resolved')


if __name__ == '__main__':
    unittest.main()
