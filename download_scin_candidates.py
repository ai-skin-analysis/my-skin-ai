"""Download only SCIN research candidates selected by ``import_scin_metadata``.

The downloader is intentionally separate from the metadata audit and never
writes images into the 50-class training folders.  Every download stays under
``dataset/source_data/scin/images`` with a provenance ledger.  It cannot train
or activate a model.
"""

import argparse
import csv
import hashlib
import json
import shutil
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote
from urllib.request import urlopen


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_MANIFEST = (
    PROJECT_ROOT / 'dataset' / 'multiclass' / 'scin_metadata_audit'
    / 'scin_research_candidate_manifest.csv'
)
DEFAULT_DESTINATION = PROJECT_ROOT / 'dataset' / 'source_data' / 'scin' / 'images'
DEFAULT_REPORT = (
    PROJECT_ROOT / 'dataset' / 'multiclass' / 'scin_metadata_audit'
    / 'scin_image_download.report.json'
)
BUCKET = 'dx-scin-public-data'


def safe_relative_image_path(source_path):
    """Validate SCIN's published relative path before creating a local path."""
    path = PurePosixPath(source_path)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Image path must be a relative SCIN dataset path.')
    if len(path.parts) != 3 or path.parts[:2] != ('dataset', 'images'):
        raise ValueError('Image path is outside the SCIN dataset/images prefix.')
    if path.suffix.lower() not in {'.jpg', '.jpeg', '.png', '.webp'}:
        raise ValueError('Image path has an unsupported image extension.')
    return path


def image_url(source_path):
    relative = safe_relative_image_path(source_path).as_posix()
    return (
        f'https://storage.googleapis.com/download/storage/v1/b/{BUCKET}/o/'
        f'{quote(relative, safe="")}?alt=media'
    )


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as image_file:
        for block in iter(lambda: image_file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def download_one(job, destination, retries=4):
    """Fetch a source image atomically, retaining case-level provenance."""
    source_path = safe_relative_image_path(job['source_path'])
    local_path = Path(destination, job['case_id'], source_path.name)
    local_path.parent.mkdir(parents=True, exist_ok=True)
    if local_path.is_file() and local_path.stat().st_size > 0:
        return {
            **job,
            'local_path': str(local_path),
            'sha256': file_sha256(local_path),
            'outcome': 'already_present',
        }

    temporary_path = local_path.with_suffix(local_path.suffix + '.part')
    last_error = None
    for attempt in range(retries + 1):
        try:
            with urlopen(image_url(source_path.as_posix()), timeout=45) as response:
                if getattr(response, 'status', 200) != 200:
                    raise RuntimeError(f'Unexpected HTTP status {response.status}')
                with temporary_path.open('wb') as output_file:
                    shutil.copyfileobj(response, output_file)
            if temporary_path.stat().st_size == 0:
                raise RuntimeError('Downloaded file was empty.')
            temporary_path.replace(local_path)
            break
        except Exception as error:
            last_error = error
            temporary_path.unlink(missing_ok=True)
            if attempt == retries:
                raise
            time.sleep(min(2 ** attempt, 12))
    return {
        **job,
        'local_path': str(local_path),
        'sha256': file_sha256(local_path),
        'outcome': 'downloaded',
    }


def load_jobs(manifest_path, limit=None, skip=0):
    jobs = []
    seen = set()
    with Path(manifest_path).open(encoding='utf-8', newline='') as manifest_file:
        for row in csv.DictReader(manifest_file):
            for source_path in json.loads(row['image_paths']):
                source_path = safe_relative_image_path(source_path).as_posix()
                key = (row['case_id'], source_path)
                if key in seen:
                    continue
                seen.add(key)
                if len(seen) <= skip:
                    continue
                jobs.append({
                    'case_id': row['case_id'],
                    'target_id': row['target_id'],
                    'source_primary_label': row['source_primary_label'],
                    'source_primary_weight': row['source_primary_weight'],
                    'source_path': source_path,
                })
                if limit is not None and len(jobs) >= limit:
                    return jobs
    return jobs


def download_candidates(manifest_path, destination, workers=6, limit=None, skip=0, retries=4):
    jobs = load_jobs(manifest_path, limit=limit, skip=skip)
    records, errors = [], []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(download_one, job, destination, retries=retries): job
            for job in jobs
        }
        for future in as_completed(futures):
            job = futures[future]
            try:
                records.append(future.result())
            except Exception as error:  # record the source path; do not silently skip it
                errors.append({**job, 'error': str(error)})
    records.sort(key=lambda record: (record['case_id'], record['source_path']))
    errors.sort(key=lambda record: (record['case_id'], record['source_path']))
    return jobs, records, errors


def write_report(report_path, manifest_path, destination, requested, records, errors):
    report_path = Path(report_path)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    ledger_path = report_path.with_name('scin_image_download_ledger.jsonl')
    with ledger_path.open('w', encoding='utf-8') as ledger_file:
        for record in records:
            ledger_file.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + '\n')
    report = {
        'schema_version': 1,
        'status': 'research_source_download_not_training_or_model_activation',
        'downloaded_at_utc': datetime.now(timezone.utc).isoformat(),
        'source': {
            'dataset': 'Skin Condition Image Network (SCIN)',
            'bucket': f'gs://{BUCKET}/dataset/images/',
            'license': 'SCIN Data Use License',
            'attribution_required': True,
            'reidentification_prohibited': True,
        },
        'candidate_manifest': str(Path(manifest_path).resolve()),
        'destination': str(Path(destination).resolve()),
        'requested_image_count': len(requested),
        'downloaded_image_count': sum(record['outcome'] == 'downloaded' for record in records),
        'already_present_image_count': sum(record['outcome'] == 'already_present' for record in records),
        'error_count': len(errors),
        'errors': errors[:100],
        'provenance_ledger': str(ledger_path.resolve()),
        'model_activation': False,
        'next_gate': 'Downloaded source material is not training-ready. Preserve contribution-disjoint splits, deduplicate all sources, and evaluate before any research experiment.',
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return report


def parse_args():
    parser = argparse.ArgumentParser(description='Download selected SCIN source images without training or activating a model.')
    parser.add_argument('--manifest', default=str(DEFAULT_MANIFEST))
    parser.add_argument('--destination', default=str(DEFAULT_DESTINATION))
    parser.add_argument('--report', default=str(DEFAULT_REPORT))
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--retries', type=int, default=4, help='Retry count for transient network failures per image.')
    parser.add_argument('--skip', type=int, default=0, help='Skip this many manifest image entries; useful for non-overlapping download partitions.')
    parser.add_argument('--limit', type=int, help='Download only this many candidate images for a bounded test run.')
    parser.add_argument('--accept-scin-license', action='store_true', help='Required acknowledgement of the SCIN Data Use License before any download.')
    return parser.parse_args()


def main():
    args = parse_args()
    if not args.accept_scin_license:
        raise SystemExit('Refusing to download: pass --accept-scin-license after reading the SCIN Data Use License.')
    if args.workers < 1 or args.workers > 12:
        raise SystemExit('--workers must be between 1 and 12.')
    if args.limit is not None and args.limit < 1:
        raise SystemExit('--limit must be at least 1.')
    if args.skip < 0:
        raise SystemExit('--skip must be zero or greater.')
    if args.retries < 0 or args.retries > 8:
        raise SystemExit('--retries must be between 0 and 8.')
    if not Path(args.manifest).is_file():
        raise SystemExit(f'Candidate manifest not found: {args.manifest}')

    requested, records, errors = download_candidates(
        args.manifest,
        args.destination,
        workers=args.workers,
        limit=args.limit,
        skip=args.skip,
        retries=args.retries,
    )
    report = write_report(args.report, args.manifest, args.destination, requested, records, errors)
    print(f'Requested: {report["requested_image_count"]}')
    print(f'Downloaded: {report["downloaded_image_count"]}')
    print(f'Already present: {report["already_present_image_count"]}')
    print(f'Errors: {report["error_count"]}')
    print(f'Report: {args.report}')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
