import json
import tempfile
import unittest
from pathlib import Path

import prepare_multiclass_dataset as preparation


class TestDatasetPreparation(unittest.TestCase):
    def test_scaffold_creates_all_fifty_class_folders_and_safe_templates(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            dataset_path = Path(temporary_directory) / 'multiclass'
            classes = preparation.load_catalog()

            preparation.write_scaffold(dataset_path, classes)
            report = preparation.inspect_dataset(dataset_path, classes, minimum_images=200, check_duplicates=True)

            self.assertEqual(len([path for path in dataset_path.iterdir() if path.is_dir()]), 50)
            self.assertTrue((dataset_path / 'class_mapping.csv').is_file())
            template = json.loads((dataset_path / 'dataset_manifest.template.json').read_text(encoding='utf-8'))
            self.assertFalse(template['approved_for_training'])
            self.assertEqual(len(template['class_ids']), 50)
            self.assertFalse(report['ready_for_training'])
            self.assertEqual(len(report['classes_below_minimum']), 50)
            self.assertEqual(report['unexpected_class_folders'], [])
            self.assertEqual(report['manifest_status'], 'missing')
            self.assertTrue(report['duplicates_checked'])
            self.assertEqual(report['duplicate_image_group_count'], 0)

    def test_unexpected_legacy_folder_blocks_the_catalog_preflight(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            dataset_path = Path(temporary_directory) / 'multiclass'
            classes = preparation.load_catalog()
            preparation.write_scaffold(dataset_path, classes)
            (dataset_path / 'retired_class').mkdir()

            report = preparation.inspect_dataset(dataset_path, classes, minimum_images=1, check_duplicates=True)

            self.assertEqual(report['unexpected_class_folders'], ['retired_class'])
            self.assertFalse(report['ready_for_training'])


if __name__ == '__main__':
    unittest.main()
