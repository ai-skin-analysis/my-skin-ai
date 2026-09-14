import json
import tempfile
import unittest
from pathlib import Path

import train_multiclass


class TestTrainingDataValidation(unittest.TestCase):
    def test_duplicate_image_content_across_classes_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / 'class_a').mkdir()
            (root / 'class_b').mkdir()
            (root / 'class_a' / 'one.jpg').write_bytes(b'same-image-content')
            (root / 'class_b' / 'two.jpg').write_bytes(b'same-image-content')

            with self.assertRaisesRegex(ValueError, 'duplicate image content'):
                train_multiclass.validate_data_directory(root, ['class_a', 'class_b'], 1)

    def test_manifest_must_be_approved_and_match_command_provenance(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest_path = Path(temporary_directory) / 'dataset_manifest.json'
            manifest_path.write_text(json.dumps({
                'schema_version': 1,
                'dataset_id': 'approved-set',
                'source': 'https://example.test/source',
                'license': 'Approved DUA',
                'approval_record': 'IRB-123',
                'approved_for_training': True,
                'class_ids': ['class_a'],
            }), encoding='utf-8')

            manifest = train_multiclass.load_dataset_manifest(
                manifest_path,
                'https://example.test/source',
                'Approved DUA',
                ['class_a'],
            )
            self.assertEqual(manifest['dataset_id'], 'approved-set')
            self.assertTrue(manifest['manifest_sha256'])

            with self.assertRaisesRegex(ValueError, 'must exactly match'):
                train_multiclass.load_dataset_manifest(manifest_path, 'other-source', 'Approved DUA', ['class_a'])

    def test_manifest_rejects_blank_provenance_or_duplicate_class_ids(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest_path = Path(temporary_directory) / 'dataset_manifest.json'
            manifest_path.write_text(json.dumps({
                'schema_version': 1,
                'dataset_id': ' ',
                'source': 'https://example.test/source',
                'license': 'Approved DUA',
                'approval_record': 'IRB-123',
                'approved_for_training': True,
                'class_ids': ['class_a', 'class_a'],
            }), encoding='utf-8')

            with self.assertRaisesRegex(ValueError, 'dataset_id'):
                train_multiclass.load_dataset_manifest(
                    manifest_path,
                    'https://example.test/source',
                    'Approved DUA',
                    ['class_a'],
                )

            manifest_path.write_text(json.dumps({
                'schema_version': 1,
                'dataset_id': 'approved-set',
                'source': 'https://example.test/source',
                'license': 'Approved DUA',
                'approval_record': 'IRB-123',
                'approved_for_training': True,
                'class_ids': ['class_a', 'class_a'],
            }), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'unique list'):
                train_multiclass.load_dataset_manifest(
                    manifest_path,
                    'https://example.test/source',
                    'Approved DUA',
                    ['class_a'],
                )

    def test_data_directory_rejects_class_folder_outside_the_catalog(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / 'class_a').mkdir()
            (root / 'retired_class').mkdir()
            (root / 'class_a' / 'one.jpg').write_bytes(b'image-content')

            with self.assertRaisesRegex(ValueError, 'unexpected class folders'):
                train_multiclass.validate_data_directory(root, ['class_a'], 1)


if __name__ == '__main__':
    unittest.main()
