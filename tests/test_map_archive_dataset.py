import tempfile
import unittest
import zipfile
from pathlib import Path

import map_archive_dataset as mapper


class TestArchiveMapping(unittest.TestCase):
    def setUp(self):
        self.catalog = {
            'acne_vulgaris': {'id': 'acne_vulgaris', 'name_en': 'Acne vulgaris', 'name_th': 'สิว'},
            'herpes_zoster': {'id': 'herpes_zoster', 'name_en': 'Herpes zoster', 'name_th': 'งูสวัด'},
        }
        self.rules = [
            {'target_id': 'acne_vulgaris', 'include_any': ['acne']},
            {'target_id': 'herpes_zoster', 'include_any': ['herpes zoster']},
        ]

    def test_camel_case_filename_maps_only_from_the_filename(self):
        row = mapper.map_member(
            'train/Atopic Dermatitis Photos/AcneClosedComedo12.jpg',
            self.rules,
            [],
            self.catalog,
        )
        self.assertEqual(row['target_id'], 'acne_vulgaris')
        self.assertEqual(row['mapping_status'], 'candidate_direct_filename_review_required')
        self.assertEqual(row['source_folder'], 'Atopic Dermatitis Photos')

    def test_nonclinical_filename_is_excluded_even_when_it_contains_a_condition(self):
        row = mapper.map_member(
            'train/Images/acne-histology-1.jpg',
            self.rules,
            ['histology'],
            self.catalog,
        )
        self.assertEqual(row['mapping_status'], 'excluded_nonclinical_or_unsupported_modality')
        self.assertEqual(row['target_id'], '')

    def test_multiple_rule_matches_are_never_auto_assigned(self):
        row = mapper.map_member(
            'test/Images/acne-herpes-zoster.jpg',
            self.rules,
            [],
            self.catalog,
        )
        self.assertEqual(row['mapping_status'], 'needs_manual_review_multiple_candidates')
        self.assertIn('acne_vulgaris', row['target_id'])
        self.assertIn('herpes_zoster', row['target_id'])

    def test_mapping_report_hashes_exact_archive_rules_catalog_and_output(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            archive_path = root / 'images.zip'
            output_path = root / 'mapping.csv'
            report_path = root / 'mapping.report.json'
            with zipfile.ZipFile(archive_path, 'w') as archive:
                archive.writestr('train/clinical/acne-photo.jpg', b'image-bytes')

            report = mapper.create_mapping(
                archive_path,
                mapper.DEFAULT_RULES,
                mapper.DEFAULT_CATALOG,
                output_path,
                report_path,
            )

            self.assertEqual(report['archive_sha256'], mapper.sha256_file(archive_path))
            self.assertEqual(report['rules_sha256'], mapper.sha256_file(mapper.DEFAULT_RULES))
            self.assertEqual(report['catalog_sha256'], mapper.sha256_file(mapper.DEFAULT_CATALOG))
            self.assertEqual(report['output_sha256'], mapper.sha256_file(output_path))
            self.assertTrue(report_path.is_file())
