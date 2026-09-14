import csv
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from download_scin_candidates import download_one, image_url, load_jobs, safe_relative_image_path


class ScinImageDownloadTests(unittest.TestCase):
    def test_allows_only_published_scin_image_paths(self):
        path = safe_relative_image_path('dataset/images/example.png')
        self.assertEqual(path.as_posix(), 'dataset/images/example.png')
        self.assertIn('dx-scin-public-data', image_url(path.as_posix()))

    def test_rejects_path_traversal_and_non_image_objects(self):
        with self.assertRaises(ValueError):
            safe_relative_image_path('../dataset/images/example.png')
        with self.assertRaises(ValueError):
            safe_relative_image_path('dataset/scin_labels.csv')
        with self.assertRaises(ValueError):
            safe_relative_image_path('dataset/images/example.csv')

    def test_can_select_a_non_overlapping_manifest_partition(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = Path(temp_dir) / 'manifest.csv'
            with manifest.open('w', encoding='utf-8', newline='') as output_file:
                writer = csv.DictWriter(output_file, fieldnames=[
                    'case_id', 'target_id', 'source_primary_label', 'source_primary_weight', 'image_paths',
                ])
                writer.writeheader()
                writer.writerow({
                    'case_id': 'a', 'target_id': 'psoriasis', 'source_primary_label': 'Psoriasis',
                    'source_primary_weight': '1', 'image_paths': json.dumps(['dataset/images/a.png']),
                })
                writer.writerow({
                    'case_id': 'b', 'target_id': 'eczema_unspecified', 'source_primary_label': 'Eczema',
                    'source_primary_weight': '1', 'image_paths': json.dumps(['dataset/images/b.png']),
                })
            jobs = load_jobs(manifest, skip=1)

        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]['case_id'], 'b')

    def test_retries_a_transient_download_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            job = {'case_id': 'a', 'source_path': 'dataset/images/a.png'}
            with patch('download_scin_candidates.urlopen', side_effect=OSError('temporary DNS failure')) as request:
                with self.assertRaises(OSError):
                    download_one(job, Path(temp_dir), retries=2)

        self.assertEqual(request.call_count, 3)


if __name__ == '__main__':
    unittest.main()
